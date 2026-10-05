// Experimentos de caos prontos: usados pela aba Caos (presets) e por
// scripts/chaos-experiments.mjs (que verifica a hipótese de cada um).
// Alvos e tipos: src/common/chaos.mjs. Só dados: o arquivo roda no navegador e no Node
export const CHAOS_PRESETS = [
    {
        id: 'payment-flaky',
        label: 'Pagamento instável',
        hypothesis: 'Metade das cobranças falha por throttling; o retry do Step Functions repete e todas as compras concluem.',
        expect: 'COMPLETED',
        faults: [{ id: 'payment-flaky', service: 'payments', action: 'processPayment', type: 'transient', probability: 0.5 }]
    },
    {
        id: 'payment-down',
        label: 'Pagamento fora do ar',
        hypothesis: 'Toda cobrança falha sem retry; as compras são desfeitas (COMPENSATED) e o estoque volta ao valor de antes.',
        expect: 'COMPENSATED',
        faults: [{ id: 'payment-down', service: 'payments', action: 'processPayment', type: 'crash', probability: 1 }]
    },
    {
        id: 'refund-flaky',
        label: 'Reembolso instável',
        hypothesis: 'A confirmação do pedido falha depois da cobrança e o reembolso falha metade das vezes; a compensação repete e conclui, sem CompensationFailed.',
        expect: 'COMPENSATED',
        faults: [
            { id: 'confirm-down', service: 'orders', action: 'confirmOrder', type: 'crash', probability: 1 },
            { id: 'refund-flaky', service: 'payments', action: 'refundPayment', type: 'transient', probability: 0.5 }
        ]
    },
    {
        id: 'products-down',
        label: 'Catálogo fora do ar',
        hypothesis: 'A consulta do produto ao iniciar a compra falha (503 com Retry-After, sem criar saga); depois de N falhas seguidas o circuit breaker abre e recusa as compras seguintes na hora, sem invocar Products.',
        expect: 'REJECTED',
        // Acima do limite do breaker (10 no LocalStack, 5 na AWS) e uma por vez:
        // compras simultâneas do mesmo produto dividem a invocação e contam uma falha só
        orders: 12,
        sequential: true,
        faults: [{ id: 'products-down', service: 'products', action: 'getProduct', type: 'crash', probability: 1 }]
    },
    {
        id: 'slow-step',
        label: 'Reserva de estoque lenta',
        hypothesis: 'Metade das reservas demora 6 s (acima do timeout de 5 s do passo na AWS); o passo é repetido e a reserva idempotente não reserva em dobro.',
        expect: 'COMPLETED',
        faults: [{ id: 'slow-step', service: 'stock', action: 'reserveStock', type: 'latency', probability: 0.5, latencyMs: 6000 }]
    },
    {
        id: 'event-dlq',
        label: 'Eventos de produto na DLQ',
        hypothesis: 'O Stock falha ao processar ProductCreated; depois das tentativas o evento vai para a DLQ, e reprocessá-lo após desligar o caos cria o inventário.',
        expect: 'DLQ',
        // Local não há EventBridge nem DLQ: o local-server entrega o evento em processo
        awsOnly: true,
        faults: [{ id: 'event-dlq', service: 'stock', action: 'products/ProductCreated', type: 'transient', probability: 1 }]
    }
];

export const CHAOS_SERVICES = ['products', 'orders', 'payments', 'stock', 'saga'];
export const CHAOS_FAULT_TYPES = {
    latency: 'Latência',
    transient: 'Falha transitória',
    crash: 'Erro (sem retry)',
    unavailable: 'Indisponível (503)'
};
