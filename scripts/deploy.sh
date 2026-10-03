#!/bin/bash

# Executa a partir da raiz do projeto, independente de onde foi chamado
cd "$(dirname "$0")/.." || exit 1

echo "🚀 Deploying Distributed E-Commerce System to AWS"
echo "=============================================="

# Verifica se AWS CLI está instalado
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI não encontrado. Por favor, instale a AWS CLI."
    exit 1
fi

# Verifica se as credenciais AWS estão configuradas
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ Credenciais AWS não configuradas. Por favor, configure suas credenciais:"
    echo "   aws configure"
    echo "   ou configure variáveis de ambiente AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN"
    exit 1
fi

# O bucket S3 de artefatos é criado/gerenciado pelo SAM (resolve_s3 = true no samconfig.toml)

echo ""
echo "📦 Empacotando código..."
# npm run adiciona node_modules/.bin ao PATH, onde está o esbuild usado pelo SAM
npm install --no-audit --no-fund
npm run build || exit 1

echo ""
echo "🚀 Fazendo deploy na AWS..."
sam deploy --config-file samconfig.toml || exit 1

echo ""
echo "✅ Deployment concluído!"

# Exibe os outputs do stack
echo ""
echo "📊 Recursos Criados:"
echo "=================="

# Aguarda alguns segundos para o stack estar pronto
sleep 10

# Pega o URL da API Gateway
API_URL=$(aws cloudformation describe-stacks \
    --stack-name distributed-ecommerce-system \
    --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" \
    --output text 2>/dev/null || echo "")

if [ ! -z "$API_URL" ]; then
    echo "🌐 API Gateway URL: $API_URL"
    echo ""
    echo "🧪 Testar endpoints:"
    echo "   Health:     $API_URL/health"
    echo "   Products:   $API_URL/products"
    echo "   Orders:     $API_URL/orders"
    echo "   Payments:   $API_URL/payments"
    echo "   Stock:      $API_URL/stock"
    echo "   Saga:       curl -X POST $API_URL/saga/execute -d '{\"productId\":\"apple\",\"quantity\":1}'"
    echo ""
    echo "🌱 Popular produtos: npm run seed -- --stage dev"
else
    echo "⚠️  Não foi possível obter a URL da API Gateway. Verifique o CloudFormation stack."
fi

echo ""
echo "🎉 Pronto! O sistema está no ar!"