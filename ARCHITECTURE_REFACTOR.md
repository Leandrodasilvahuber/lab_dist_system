# Arquitetura Refatorada - Resolvendo 4 Problemas Críticos

## Problemas Identificados

1. ❌ **Sem API Gateway - endpoints expostos diretamente**
   - API Gateway duplicada e mal configurada no template.yaml
   - Algumas funções Lambda não têm eventos de API Gateway
   - Roteamento inconsistente

2. ❌ **Tight coupling - importação direta entre módulos**
   - SagaOrchestratorController: `import { Product } from '../../products/src/models/Product.js'`
   - Dependências diretas entre módulos via imports absolutos
   - Dificulta testes e manutenção

3. ❌ **Acoplamento de estrutura - depende de paths de importação**
   - Caminhos relativos como `../../../..` para importar Database
   - Frágil - qualquer mudança na estrutura quebra

4. ❌ **Deploy problema - módulos acoplados, mudanças propagam**
   - Cada módulo acessa DynamoDB diretamente
   - SagaOrchestrator importa diretamente de outros serviços
   - Não existe camada de abstração ou SDKs por serviço

## Solução Proposta

### 1. Criar API Gateway Centralizado (Problema #1)

#### Estrutura Proposta:
```
src/
├── layers/
│   ├── api-gateway-layer/
│   │   ├── src/
│   │   │   ├── middleware/
│   │   │   │   ├── authMiddleware.js
│   │   │   │   └── errorHandler.js
│   │   │   └── routes/
│   │   │       ├── apiRoutes.js        # API Gateway central
│   │   │       └── swagger.js          # Documentação OpenAPI
│   │   └── template.yaml
│   └── shared/
│       ├── database.mjs                 # Biblioteca comum de database
│       └── response.mjs                 # Helper de responses
└── ecommerce/
    ├── products/
    │   ├── src/
    │   │   ├── controllers/
    │   │   │   ├── ProductController.js
    │   │   │   └── ProductSDK.js        # SDK Público do produto
    │   │   └── services/
    │   │       └── ProductService.js   # Serviço interno
    │   └── template.yaml
    └── saga-orchestrator/
        └── template.yaml
```

#### API Gateway Central:
```yaml
# layers/api-gateway-layer/template.yaml
ApiGateway:
  Type: AWS::Serverless::HttpApi
  Properties:
    StageName: !Ref Environment
    CorsConfiguration:
      AllowOrigins: "'*'"
      AllowMethods: "'*'"
      AllowHeaders: "'*'"
    DefaultRoute: $default
    Auth:
      DefaultAuthorizer: NONE  # Pode configurar JWT depois

ProductsAPI:
  Type: AWS::Serverless::HttpApi
  Properties:
    StageName: !Ref Environment
    CorsConfiguration:
      AllowOrigins: "'*'"
      AllowMethods: "'*'"
    Routes:
      - Path: /products
        Method: GET
        Target: !GetAtt ProductFunction.Arn
      - Path: /products/{id}
        Method: GET
        Target: !GetAtt ProductFunction.Arn
      - Path: /products
        Method: POST
        Target: !GetAtt ProductFunction.Arn
```

### 2. Criar SDKs por Serviço (Problemas #2 e #3)

#### SDK Exemplo - ProductsSDK.js:
```javascript
// src/ecommerce/products/src/controllers/ProductSDK.js
/**
 * SDK Público - Interface uniforme para operações de produto
 * Saga orchestrator usa isso, não importa diretamente do products
 */
export class ProductSDK {
  constructor(eventBridgeClient) {
    this.eventBridgeClient = eventBridgeClient;
  }

  /**
   * Criar produto
   * Saga Orchestrator chama via EventBridge
   */
  async createProduct(productData) {
    const correlationId = generateCorrelationId();
    return this.eventBridgeClient.publish({
      Source: 'products',
      DetailType: 'CreateProduct',
      Detail: JSON.stringify({
        ...productData,
        correlationId
      })
    });
  }

  /**
   * Buscar produto por ID
   */
  async getProduct(productId) {
    const product = await Database.getProduct(productId);
    return Product.fromDynamo(product);
  }

  /**
   * Listar produtos
   */
  async listProducts(filters = {}) {
    const products = await Database.scanProducts(filters);
    return products.map(p => Product.fromDynamo(p));
  }
}
```

#### SagaOrchestratorController (Desacoplado):
```javascript
// src/ecommerce/saga-orchestrator/src/controllers/SagaOrchestratorController.js
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

// Injetar dependências (Dependency Injection)
export class SagaOrchestratorController {
  constructor(dependencies = {}) {
    this.productSDK = dependencies.productSDK;
    this.orderSDK = dependencies.orderSDK;
    this.paymentSDK = dependencies.paymentSDK;
    this.stockSDK = dependencies.stockSDK;
  }

  static async executeSaga(event) {
    const { productId, quantity } = event.body;

    // Usar SDK em vez de import direto
    const product = await this.productSDK.getProduct(productId);

    // Executar saga usando EventBridge
    await this.orderSDK.createOrder({
      productId,
      quantity,
      correlationId: event.headers.correlationId
    });

    await this.paymentSDK.processPayment({
      orderId,
      amount: product.price * quantity,
      correlationId: event.headers.correlationId
    });

    await this.stockSDK.reserveStock({
      productId,
      quantity,
      correlationId: event.headers.correlationId
    });

    return successResponse({ sagaId: saga.id });
  }
}
```

### 3. Interface de Compartilhamento (Problema #4)

#### src/common/contracts/ecommerce-interfaces.mjs:
```javascript
/**
 * Contratos entre serviços - contrato de interface
 */
export const EcommerceInterfaces = {
  Product: {
    createProduct: {
      input: { name, price, description, stock },
      output: { id, name, price, stock }
    },
    getProduct: {
      input: { productId },
      output: { id, name, price, description, stock }
    }
  },
  Order: {
    createOrder: {
      input: { productId, quantity },
      output: { id, status, total }
    }
  },
  Payment: {
    processPayment: {
      input: { orderId, amount },
      output: { id, status, transactionId }
    },
    refundPayment: {
      input: { transactionId, amount },
      output: { success }
    }
  },
  Stock: {
    reserveStock: {
      input: { productId, quantity },
      output: { success, reservedQuantity }
    },
    releaseStock: {
      input: { productId, quantity },
      output: { success }
    }
  }
};
```

### 4. EventBridge como Camada de Comunicação

```yaml
# template.yaml atualizado
EventBus:
  Type: AWS::EventBridge::Bus
  Properties:
    Name: !Sub '${Environment}-EcommerceEventBus'

# Event Rules
OrderCreatedRule:
  Type: AWS::EventBridge::Rule
  Properties:
    EventBusName: !Ref EventBus
    EventPattern:
      source:
        - "orders"
      detail-type:
        - "OrderCreated"
    Targets:
      - Id: PaymentTarget
        Arn: !GetAtt PaymentFunction.Arn

PaymentProcessedRule:
  Type: AWS::EventBridge::Rule
  Properties:
    EventBusName: !Ref EventBus
    EventPattern:
      source:
        - "payments"
      detail-type:
        - "PaymentProcessed"
    Targets:
      - Id: StockTarget
        Arn: !GetAtt StockFunction.Arn

StockReservedRule:
  Type: AWS::EventBridge::Rule
  Properties:
    EventBusName: !Ref EventBus
    EventPattern:
      source:
        - "stock"
      detail-type:
        - "StockReserved"
    Targets:
      - Id: OrderTarget
        Arn: !GetAtt OrderFunction.Arn
```

## Mapeamento de Problemas para Soluções

| Problema | Solução |
|----------|---------|
| 1. Sem API Gateway | Criar API Gateway centralizado em AWS Lambda HttpApi |
| 2. Tight coupling | Criar SDKs por serviço com contrato explícito |
| 3. Acoplamento de estrutura | Usar caminhos de importação consistentes (src/level/...) |
| 4. Deploy problema | Interface de contrato comum + EventBridge para comunicação |

## Benefícios

1. **Desacoplamento**: Saga orchestrator não depende de estrutura de diretórios
2. **Testabilidade**: SDKs podem ser mockados facilmente
3. **Escalabilidade**: Serviços podem ser atualizados sem afetar outros
4. **Deploy independente**: Módulos podem ser deployados separadamente
5. **Documentação**: Contratos explícitos permitem auto-documentação

## Próximos Passos

1. Criar camada de SDKs em `src/common/sdks/`
2. Criar interface de contrato em `src/common/contracts/`
3. Atualizar template.yaml com API Gateway HttpApi
4. Criar event publishers em cada serviço
5. Refatorar controllers para usar SDKs
6. Adicionar testes de integração
