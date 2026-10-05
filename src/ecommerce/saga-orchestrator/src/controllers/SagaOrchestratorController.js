import { log } from '../../../../common/logger.mjs';
import { successResponse, errorResponse, parseBody, sdkErrorResponse } from '../../../../common/response.mjs';
import { SagaService } from '../services/SagaService.js';
import { toNumber } from '../../../../common/validation.mjs';
import { parsePagination } from '../../../../common/pagination.mjs';

const sagaService = new SagaService();

// O sagaId é derivado da chave (sem namespace por cliente) e GET /saga/{id} é
// público: uma chave curta ou previsível deixaria terceiros calcularem o id.
// Use um UUID (crypto.randomUUID()) por compra.
const MIN_IDEMPOTENCY_KEY_LENGTH = 16;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class SagaOrchestratorController {
  /**
   * POST /saga/execute
   * Inicia a compra de forma assíncrona e responde 202 com o sagaId.
   * O andamento é consultado em GET /saga/{sagaId}.
   */
  static async executeSaga(event) {
    try {
      const { correlationId } = event.headers || {};
      const idempotencyKey = event.headers?.['idempotency-key'] || event.headers?.['x-idempotency-key'];
      const { productId, quantity } = parseBody(event);

      // Obrigatória: sem ela, um retry do cliente depois de um timeout (a
      // compra pode ter começado) ou de um 503 criaria uma segunda compra
      if (idempotencyKey === undefined) {
        return errorResponse('Idempotency-Key header is required (use a UUID per purchase)', 400);
      }
      if (idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        return errorResponse(
          `Idempotency-Key must have between ${MIN_IDEMPOTENCY_KEY_LENGTH} and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (use a UUID)`, 400);
      }

      if (typeof productId !== 'string' || !productId || quantity === undefined) {
        return errorResponse('Missing required fields: productId, quantity', 400);
      }

      const { saga, created } = await sagaService.startSaga({
        productId,
        quantity: toNumber(quantity),
        correlationId,
        idempotencyKey
      });

      log({
        event: created ? 'SAGA_STARTED' : 'SAGA_ALREADY_EXISTS',
        correlationId: saga.correlationId,
        status: 'info',
        message: `Saga ${saga.id} ${created ? 'started' : 'already exists'}`
      });

      return successResponse({
        sagaId: saga.id,
        orderId: saga.orderId,
        status: saga.status,
        statusUrl: `/saga/${saga.id}`
      }, created ? 202 : 200);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to start saga', event.headers?.correlationId);
    }
  }

  /**
   * Ação agendada (template.yaml, a cada 5 min; local-server, a cada minuto):
   * corrige o status das sagas paradas em andamento (SagaService.reconcile)
   */
  static reconcileStuckSagas() {
    return sagaService.reconcileStuckSagas();
  }

  /**
   * GET /saga/{sagaId}
   */
  static async getSaga(event) {
    try {
      const saga = await sagaService.getSaga(event.pathParameters.sagaId);
      return successResponse(saga);
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to get saga', event.headers?.correlationId);
    }
  }

  /**
   * GET /sagas?status=... (admin, paginado: ?limit=&nextToken=)
   */
  static async getSagas(event) {
    try {
      const query = event.queryStringParameters || {};
      const { sagas, nextToken } = await sagaService.listSagas(query, parsePagination(query));
      return successResponse({ sagas, count: sagas.length, nextToken });
    } catch (error) {
      return sdkErrorResponse(error, 'Failed to list sagas', event.headers?.correlationId);
    }
  }
}
