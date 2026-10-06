import { DependencyUnavailableError, isRetryable } from './errors.mjs';
import { log } from './logger.mjs';

/**
 * Circuit breaker para chamadas síncronas a outro serviço.
 *
 *  closed    -> chamadas passam; `failureThreshold` falhas seguidas abrem o circuito
 *  open      -> falha na hora (503, sem chamar a dependência) por `resetTimeoutMs`
 *  half-open -> deixa passar uma chamada de teste: sucesso fecha, falha reabre
 *
 * Só falhas transitórias contam (`isFailure`, por padrão isRetryable): um
 * NotFound é resposta válida de uma dependência saudável.
 *
 * O estado fica na memória do container da Lambda: cada container aprende
 * sozinho que a dependência caiu (até `failureThreshold` chamadas lentas
 * por container). É o suficiente para parar de esperar timeouts em série sem
 * depender de um armazenamento compartilhado, que também poderia falhar.
 */
export class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {number} [options.failureThreshold]
   * @param {number} [options.resetTimeoutMs]
   * @param {(error: any) => boolean} [options.isFailure]
   * @param {() => number} [options.now]
   */
  constructor({ name, failureThreshold = 5, resetTimeoutMs = 30000, isFailure = isRetryable, now = Date.now } = {}) {
    this.name = name;
    this.isFailure = isFailure;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.now = now;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.trialInFlight = false;
  }

  async call(fn) {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.resetTimeoutMs) {
        throw new DependencyUnavailableError(`${this.name} unavailable (circuit open)`, {
          retryAfterSeconds: Math.max(1, Math.ceil((this.resetTimeoutMs - elapsed) / 1000))
        });
      }
      this.transition('half-open');
    } else if (this.state === 'half-open' && this.trialInFlight) {
      // Na Lambda (uma requisição por container) não acontece; vale para o
      // local-server, que atende requisições concorrentes no mesmo processo
      throw new DependencyUnavailableError(`${this.name} unavailable (circuit half-open)`, { retryAfterSeconds: 1 });
    }

    const trial = this.state === 'half-open';
    if (trial) this.trialInFlight = true;
    try {
      const result = await fn();
      this.onSuccess(trial);
      return result;
    } catch (error) {
      // Erro que não é indisponibilidade (NotFound, erro de configuração) veio
      // de uma dependência que respondeu: conta como sucesso, inclusive para a
      // chamada de teste no half-open, que fecha o circuito. Configuração
      // errada não se resolve esperando e já aparece como 500 + UNEXPECTED_ERROR
      if (this.isFailure(error)) this.onFailure(error, trial);
      else this.onSuccess(trial);
      throw error;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  /**
   * Fora do estado fechado, só o resultado da chamada de teste muda o
   * circuito: uma chamada que começou antes da abertura e só terminou depois
   * (concorrência no local-server) não prova que a dependência voltou nem que
   * o teste falhou.
   */
  onSuccess(trial) {
    if (this.state === 'closed') {
      this.failures = 0;
    } else if (trial) {
      this.failures = 0;
      this.transition('closed');
    }
  }

  onFailure(error, trial) {
    if (this.state === 'closed') {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) this.open(error);
    } else if (trial) {
      this.open(error);
    }
  }

  open(error) {
    this.openedAt = this.now();
    this.transition('open', error);
  }

  /**
   * A abertura é falha de infraestrutura (error, com a última falha como
   * causa) e conta na métrica CircuitOpened por circuito, que tem alarme
   * próprio (CircuitBreakerOpenAlarm no template.yaml). As outras
   * transições são só informativas.
   */
  transition(state, cause) {
    const from = this.state;
    this.state = state;
    const opened = state === 'open';
    log({
      event: 'CIRCUIT_STATE_CHANGED',
      status: opened ? 'error' : 'info',
      message: `Circuit ${this.name}: ${from} -> ${state}`,
      data: { circuit: this.name, from, to: state, failures: this.failures },
      ...(opened && {
        // A causa original (timeout, ResourceNotFound...), não o 503 que a embrulha
        error: cause?.cause ?? cause,
        metrics: { metrics: { CircuitOpened: { value: 1 } }, dimensions: { Circuit: this.name }, dimensionSets: [['Circuit']] }
      })
    });
  }
}
