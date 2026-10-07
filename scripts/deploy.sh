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

ENVIRONMENT=dev
STACK_NAME=distributed-ecommerce-system
# Login de admin do dashboard (Cognito). O usuário é criado ou tem a senha
# trocada depois do deploy, só com ADMIN_PASSWORD definida. Ele só entra nas
# rotas de admin da API: não tem permissão na conta AWS nem faz deploy
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}

# O bucket S3 de artefatos é criado/gerenciado pelo SAM (resolve_s3 = true no samconfig.toml)

echo ""
echo "📦 Empacotando código..."
# npm run adiciona node_modules/.bin ao PATH, onde está o esbuild usado pelo SAM.
# npm ci instala exatamente o package-lock.json (sem alterá-lo)
npm ci --no-audit --no-fund || exit 1
npm run build || exit 1

echo ""
echo "🚀 Fazendo deploy na AWS..."
# ALERT_EMAIL: assina esse e-mail no tópico dos alarmes (AlarmTopic). A AWS
# manda um e-mail de confirmação; sem confirmar, nenhum alarme chega.
# Sem a variável no shell, vem do .env (fora do git). Só essa linha é lida:
# o .env também guarda o hash da chave de admin (local) e não é executado aqui
if [ -z "$ALERT_EMAIL" ] && [ -f .env ]; then
    ALERT_EMAIL=$(sed -n 's/^ALERT_EMAIL=//p' .env | tail -1 | tr -d "\"' \r")
fi
OVERRIDES="Environment=$ENVIRONMENT"
[ -n "$ALERT_EMAIL" ] && OVERRIDES="$OVERRIDES AlertEmail=$ALERT_EMAIL"
# Domínio próprio (opcional): DOMAIN_NAME (ex.: www.meulab.com.br) e o ID da
# hosted zone dele no Route 53. Sem os dois, o site fica só no *.cloudfront.net
if [ -n "$DOMAIN_NAME" ] && [ -n "$HOSTED_ZONE_ID" ]; then
    OVERRIDES="$OVERRIDES DomainName=$DOMAIN_NAME HostedZoneId=$HOSTED_ZONE_ID"
fi
# No GitHub Actions (CI=true) não há quem confirme o changeset, e um merge que
# não muda o stack (só docs, dashboard) não é erro
SAM_FLAGS=()
[ "$CI" = "true" ] && SAM_FLAGS=(--no-confirm-changeset --no-fail-on-empty-changeset)
sam deploy --config-file samconfig.toml "${SAM_FLAGS[@]}" \
    --parameter-overrides $OVERRIDES || exit 1
[ -n "$ALERT_EMAIL" ] && echo "📧 Confirme a assinatura no e-mail enviado para $ALERT_EMAIL (sem isso, os alarmes não chegam)"

echo ""
echo "✅ Deployment concluído!"

stack_output() {
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

USER_POOL_ID=$(stack_output AdminUserPoolId)
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
    echo "❌ Output AdminUserPoolId não encontrado no stack $STACK_NAME: login de admin não configurado"
    exit 1
fi
if [ -n "$ADMIN_PASSWORD" ]; then
    if ! aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$ADMIN_USERNAME" > /dev/null 2>&1; then
        aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username "$ADMIN_USERNAME" \
            --message-action SUPPRESS > /dev/null || exit 1
    fi
    # A senha vai por arquivo (permissão 600), não pela linha de comando, onde
    # ficaria visível para outros processos (ps). O node monta o JSON com o escape certo
    INPUT_FILE=$(umask 077 && mktemp)
    trap 'rm -f "$INPUT_FILE"' EXIT
    USER_POOL_ID="$USER_POOL_ID" ADMIN_USERNAME="$ADMIN_USERNAME" node -e 'process.stdout.write(JSON.stringify({
        UserPoolId: process.env.USER_POOL_ID, Username: process.env.ADMIN_USERNAME,
        Password: process.env.ADMIN_PASSWORD, Permanent: true }))' > "$INPUT_FILE"
    aws cognito-idp admin-set-user-password --cli-input-json "file://$INPUT_FILE" || exit 1
    rm -f "$INPUT_FILE"
    echo "🔑 Login de admin pronto: usuário $ADMIN_USERNAME"
elif ! aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$ADMIN_USERNAME" > /dev/null 2>&1; then
    echo "⚠️  Nenhum admin no Cognito ainda: rode de novo com a senha para criar o usuário $ADMIN_USERNAME:"
    echo "   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD && ./scripts/deploy.sh"
fi

# Dashboard (front): sobe dashboard/ para o bucket do CloudFront. O index.html
# fica na raiz (DefaultRootObject) e os assets em /dashboard/*, os mesmos
# caminhos do local-server. Só no bucket, runtime-config.js recebe a URL da API
# (DEFAULT_API), para o dashboard publicado não precisar de ?api=.
# Cache-Control: no-cache faz o CloudFront e o navegador revalidarem a cada
# acesso (arquivos pequenos), então o deploy novo aparece sem invalidação
echo ""
echo "🖥️  Publicando o dashboard..."
DASHBOARD_BUCKET=$(stack_output DashboardBucketName)
DASHBOARD_API=$(stack_output ApiGatewayUrl)
if [ -z "$DASHBOARD_BUCKET" ] || [ "$DASHBOARD_BUCKET" = "None" ] || [ -z "$DASHBOARD_API" ]; then
    echo "❌ Outputs DashboardBucketName/ApiGatewayUrl não encontrados no stack $STACK_NAME"
    exit 1
fi
DASHBOARD_STAGE=$(mktemp -d)
mkdir -p "$DASHBOARD_STAGE/dashboard"
cp -R dashboard/. "$DASHBOARD_STAGE/dashboard/" || exit 1
cp dashboard/index.html "$DASHBOARD_STAGE/index.html" || exit 1
# JSON.stringify: a URL entra no JS como string com o escape certo
DASHBOARD_API="$DASHBOARD_API" node -e 'process.stdout.write(
    "// Gerado por scripts/deploy.sh: API do stack para o dashboard publicado\n" +
    `export const DEFAULT_API = ${JSON.stringify(process.env.DASHBOARD_API)};\n`)' \
    > "$DASHBOARD_STAGE/dashboard/js/core/runtime-config.js" || exit 1
aws s3 sync "$DASHBOARD_STAGE" "s3://$DASHBOARD_BUCKET" --delete \
    --cache-control no-cache --only-show-errors || { rm -rf "$DASHBOARD_STAGE"; exit 1; }
rm -rf "$DASHBOARD_STAGE"
echo "🏠 Site:      $(stack_output SiteUrl)"
echo "🖥️  Dashboard: $(stack_output DashboardUrl)"

# A chave antiga (X-Api-Key) não é mais usada na AWS
if aws ssm get-parameter --name "/$ENVIRONMENT/ecommerce/admin-api-key" > /dev/null 2>&1; then
    echo "🧹 Chave antiga sem uso: aws ssm delete-parameter --name /$ENVIRONMENT/ecommerce/admin-api-key"
fi

# Exibe os outputs do stack
echo ""
echo "📊 Recursos Criados:"
echo "=================="

# O sam deploy só termina com o changeset aplicado: os outputs já existem
# Pega o URL da API Gateway
API_URL=$(stack_output ApiGatewayUrl)

if [ ! -z "$API_URL" ]; then
    echo "🌐 API Gateway URL: $API_URL"
    echo "🖥️  Dashboard:       $(stack_output DashboardUrl)"
    echo ""
    echo "🧪 Testar endpoints:"
    echo "   Health:     $API_URL/health"
    echo "   Products:   $API_URL/products"
    echo "   Stock:      $API_URL/stock"
    echo "   Orders:     $API_URL/orders"
    echo "   Admin:      faça login pelo botão Admin do dashboard (usuário $ADMIN_USERNAME)"
    echo "               ou: TOKEN=\$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id $(stack_output AdminUserPoolClientId) \\"
    echo "                     --auth-parameters USERNAME=$ADMIN_USERNAME,PASSWORD=\"\$ADMIN_PASSWORD\" --query AuthenticationResult.AccessToken --output text)"
    echo "                   curl -X DELETE -H \"Authorization: Bearer \$TOKEN\" $API_URL/products/<id>"
    echo "   Saga:       curl -X POST $API_URL/saga/execute -H \"Idempotency-Key: \$(uuidgen)\" -d '{\"productId\":\"apple\",\"quantity\":1}'"
    echo ""
    echo "🌱 Popular produtos: npm run seed -- --stage dev"
    echo "   Compras de exemplo: npm run test:e2e:orders -- --api $API_URL"
else
    echo "⚠️  Não foi possível obter a URL da API Gateway. Verifique o CloudFormation stack."
fi

echo ""
echo "🎉 Pronto! O sistema está no ar!"