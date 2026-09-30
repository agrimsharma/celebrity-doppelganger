#!/usr/bin/env bash
# Recording-session environment: BOTH projects on AKS, from nothing to live HTTPS URLs.
#   ./infra/session/up.sh        (~25-35 min; the index upload and image builds dominate)
#   ./infra/session/down.sh      (destroys everything - run it the same day)
#
# Prereqs: az login (free account), infra/azure/terraform.tfvars, the churn repo next to this one
# with its .env and its local compose db holding the complaint index, data/deploy/index here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHURN_REPO="${CHURN_REPO:-$ROOT/../saas-churn-platform}"
TF="terraform -chdir=$ROOT/infra/azure"
TAG="$(git -C "$ROOT" rev-parse --short HEAD)-$(git -C "$CHURN_REPO" rev-parse --short HEAD)"
step() { printf '\n==> %s\n' "$*"; }
envval() { grep -E "^$1=" "$CHURN_REPO/.env" | head -1 | cut -d= -f2-; }

for bin in az terraform kubectl helm docker; do command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }; done
az account show >/dev/null 2>&1 || { echo "run: az login"; exit 1; }
[ -f "$ROOT/infra/azure/terraform.tfvars" ] || { echo "copy infra/azure/terraform.tfvars.example -> terraform.tfvars"; exit 1; }
[ -f "$ROOT/data/deploy/index/thumbnails.bin" ] || python "$ROOT/scripts/package_index.py"

step "1/9 terraform apply (AKS, ACR, storage, identity, budget)"
$TF init -input=false >/dev/null
$TF apply -auto-approve -input=false
out() { $TF output -raw "$1"; }
RG=$(out resource_group); ACR=$(out acr_name); REG=$(out acr_login_server); SA=$(out storage_account)
CLIENT_ID=$(out dopp_backend_client_id); EMAIL=$(out alert_email)
eval "$(out get_credentials)"

step "2/9 ingress-nginx (public load balancer)"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update ingress-nginx jetstack >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"=/healthz \
  --wait --timeout 10m >/dev/null
for _ in $(seq 1 60); do
  IP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [ -n "$IP" ] && break; sleep 5
done
DOMAIN="$IP.sslip.io"   # wildcard DNS that resolves <anything>.<ip>.sslip.io to the ip - no domain to buy
echo "ingress: $IP  ->  *.$DOMAIN"

step "3/9 cert-manager + Let's Encrypt"
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set crds.enabled=true --wait --timeout 10m >/dev/null
kubectl apply -f - >/dev/null <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $EMAIL
    privateKeySecretRef: {name: letsencrypt-account}
    solvers:
      - http01: {ingress: {ingressClassName: nginx}}
YAML

step "4/9 Prometheus + Grafana"
GRAFANA_HOST="grafana.$DOMAIN" GRAFANA_TLS=1 "$ROOT/infra/monitoring/install.sh"

step "5/9 images -> $REG (built remotely by ACR on amd64, tag $TAG)"
az acr build -r "$ACR" -t "doppelganger-backend:$TAG" -f "$ROOT/backend/Dockerfile" "$ROOT" --no-logs -o none
az acr build -r "$ACR" -t "doppelganger-frontend:$TAG" "$ROOT/frontend" --no-logs -o none
az acr build -r "$ACR" -t "churn-api:$TAG" -f "$CHURN_REPO/service/Dockerfile" --build-arg WITH_NLP=true "$CHURN_REPO" --no-logs -o none
az acr build -r "$ACR" -t "churn-dashboard:$TAG" -f "$CHURN_REPO/dashboard/Dockerfile" "$CHURN_REPO" --no-logs -o none

step "6/9 face index -> private blob storage (~1 GB)"
for attempt in $(seq 1 12); do   # the role assignment can take a few minutes to propagate
  az storage blob upload-batch --auth-mode login --account-name "$SA" -d index -s "$ROOT/data/deploy/index" \
    --overwrite --only-show-errors -o none && break
  echo "  waiting for storage permissions ($attempt/12)..."; sleep 20
done

step "7/9 doppelganger"
helm upgrade --install doppelganger "$ROOT/infra/helm/doppelganger" -n doppelganger --create-namespace \
  -f "$ROOT/infra/helm/doppelganger/values-aks.yaml" \
  --set backend.image.repository="$REG/doppelganger-backend" --set backend.image.tag="$TAG" \
  --set frontend.image.repository="$REG/doppelganger-frontend" --set frontend.image.tag="$TAG" \
  --set index.azureBlob.account="$SA" \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"="$CLIENT_ID" \
  --set ingress.host="doppelganger.$DOMAIN" \
  --set-string backend.apiKey="$(openssl rand -hex 16)" \
  --wait --timeout 15m >/dev/null

step "8/9 churn platform"
helm upgrade --install churn "$CHURN_REPO/deploy/helm/churn-platform" -n churn --create-namespace \
  -f "$CHURN_REPO/deploy/helm/churn-platform/values-aks.yaml" \
  --set api.image.repository="$REG/churn-api" --set api.image.tag="$TAG" \
  --set dashboard.image.repository="$REG/churn-dashboard" --set dashboard.image.tag="$TAG" \
  --set api.complaintsModel.hub="${COMPLAINTS_MODEL_REPO:-}" \
  --set ingress.domain="$DOMAIN" \
  --set-string secrets.apiKey="$(envval API_KEY)" \
  --set-string secrets.postgresPassword="$(openssl rand -hex 16)" \
  --set-string secrets.anthropicApiKey="$(envval ANTHROPIC_API_KEY)" \
  --set-string secrets.slackWebhookUrl="$(envval SLACK_WEBHOOK_URL)" \
  --wait --timeout 15m >/dev/null

step "9/9 complaint vector index -> cluster Postgres"
"$CHURN_REPO/scripts/k8s_load_index.sh" churn churn

cat <<DONE

Everything is up (TLS certificates can take a minute or two to issue):
  Doppelganger:  https://doppelganger.$DOMAIN
  Churn:         https://churn.$DOMAIN
  n8n:           https://n8n.$DOMAIN        (create the owner account on first visit)
  API docs:      https://churn-api.$DOMAIN/docs
  Grafana:       https://grafana.$DOMAIN    (admin / kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)

Recording checklist: infra/session/RECORDING.md.  When done:  ./infra/session/down.sh
DONE
