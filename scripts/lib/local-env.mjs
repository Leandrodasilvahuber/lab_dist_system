// Padrões de ambiente do local-server (LocalStack). Importado antes de todos os
// outros módulos: os imports estáticos rodam antes do corpo do local-server, e
// alguns leem a configuração ao carregar (ex.: TIMEOUT_SCALE em aws-client.mjs,
// trazido por response.mjs)
process.env.AWS_ENDPOINT ||= 'http://localhost:4566';
process.env.AWS_REGION ||= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ||= 'test';
// Credencial fictícia do LocalStack, não é segredo
process.env.AWS_SECRET_ACCESS_KEY ||= 'test'; // nosemgrep
