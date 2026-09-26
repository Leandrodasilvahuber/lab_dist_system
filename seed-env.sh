#!/bin/bash

echo "🌱 Populando banco de dados com produtos iniciais"
echo "=============================================="

# Verifica se AWS CLI está configurado
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ Credenciais AWS não configuradas. Por favor, configure suas credenciais:"
    echo "   aws configure"
    exit 1
fi

# Verifica se as tabelas DynamoDB existem
echo "📋 Verificando tabelas DynamoDB..."

# Lista de tabelas esperadas
TABLES=(
    "dev-Products"
    "dev-Orders"
    "dev-Payments"
    "dev-Stock"
    "dev-StockReservations"
)

# Verifica cada tabela
for table in "${TABLES[@]}"; do
    if aws dynamodb describe-table --table-name "$table" &>/dev/null; then
        echo "✅ Tabela $table existe"
    else
        echo "❌ Tabela $table não encontrada. Faça o deploy primeiro com ./deploy.sh"
    fi
done

echo ""
echo "🍎 Executando seed de produtos..."

# Executa o script de seed
node seed-aws.mjs

echo ""
echo "✅ Seed concluído!"
echo ""
echo "📊 Dados inseridos:"
echo "   - Apple: 10 unidades"
echo "   - Banana: 15 unidades"
echo "   - Orange: 20 unidades"
echo "   - Grape: 30 unidades"
echo ""
echo "🧪 Você pode testar os endpoints:"
echo "   curl \$(aws cloudformation describe-stacks --stack-name distributed-ecommerce-system --query \"Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue\" --output text)/products"