#!/bin/bash

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

# Cria bucket S3 para o pacote se não existir
BUCKET_NAME="aws-sam-cli-managed-default-samclisourcebucket"
REGION=$(aws configure get region || echo "us-east-1")

echo "📁 Verificando bucket S3..."
aws s3 ls s3://$BUCKET_NAME --region $REGION || {
    echo "⚠️  Bucket S3 não encontrado, será criado pelo SAM durante o deploy"
}

echo ""
echo "📦 Empacotando código..."
sam build

echo ""
echo "🚀 Fazendo deploy na AWS..."
sam deploy --config-file samconfig.toml

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
else
    echo "⚠️  Não foi possível obter a URL da API Gateway. Verifique o CloudFormation stack."
fi

echo ""
echo "🎉 Pronto! O sistema está no ar!"