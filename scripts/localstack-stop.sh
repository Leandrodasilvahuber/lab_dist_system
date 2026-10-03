#!/bin/bash
# Para o LocalStack (os dados ficam em ./localstack-data)
cd "$(dirname "$0")/.." || exit 1

echo "🛑 Parando LocalStack..."
docker compose down
echo "✅ LocalStack parado"
