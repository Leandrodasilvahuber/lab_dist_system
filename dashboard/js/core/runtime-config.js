// API padrão do dashboard. Vazio no repositório: o dashboard usa a própria
// origem (local-server). No deploy (scripts/deploy.sh) este arquivo é trocado,
// só no bucket do CloudFront, por um com a ApiGatewayUrl do stack
export const DEFAULT_API = '';
