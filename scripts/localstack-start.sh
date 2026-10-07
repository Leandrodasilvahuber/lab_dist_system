#!/bin/bash
# Sobe o LocalStack (DynamoDB, Lambda, Step Functions, EventBridge, SQS)
cd "$(dirname "$0")/.." || exit 1

echo "🐳 Iniciando LocalStack..."
docker compose up -d localstack || exit 1

echo "⏳ Aguardando os serviços ficarem disponíveis..."
for _ in $(seq 1 60); do
    if curl -s http://localhost:4566/_localstack/health | grep -q '"stepfunctions": "\(available\|running\)"'; then
        echo "✅ LocalStack pronto em http://localhost:4566"
        echo ""
        echo "Próximos passos:"
        echo "   npm run build              # empacota as Lambdas"
        echo "   npm run localstack:deploy  # publica as Lambdas e a saga"
        echo "   npm run local-server       # dashboard em http://localhost:3001/laboratory"
        echo "   npm run seed:local         # dev: produtos e estoque (seed:local:prod: sem o server)"
        echo "   npm run test:e2e:orders    # compras de exemplo no dashboard"
        echo "   npm run test:e2e           # roda a saga completa no LocalStack"
        echo "   npm run localstack:stop    # para tudo"
        exit 0
    fi
    sleep 2
done

echo "❌ LocalStack não respondeu. Veja os logs: docker compose logs localstack"
exit 1
