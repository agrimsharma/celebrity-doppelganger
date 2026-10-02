#!/usr/bin/env bash
# Recording-session environment on GKE: BOTH projects, from nothing to live HTTPS URLs.
#   ./infra/session/up-gcp.sh        (~30-45 min; image builds and the cluster dominate)
#   ./infra/session/down-gcp.sh      (deletes everything - run it the same day)
#
# Prereqs: gcloud auth login + gcloud auth application-default login (your own account, Owner
# on the project), infra/terraform/terraform.tfvars with project_id, the churn repo next to this
# one with its .env, and Docker running its local db (the complaint index is copied from it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHURN_REPO="${CHURN_REPO:-$ROOT/../saas-churn-platform}"
TF="terraform -chdir=$ROOT/infra/terraform"
TAG="$(git -C "$ROOT" rev-parse --short HEAD)-$(git -C "$CHURN_REPO" rev-parse --short HEAD)"
COMPLAINTS_MODEL_REPO="${COMPLAINTS_MODEL_REPO:-agrim-sharma/cfpb-complaints-distilbert}"
step() { printf '\n==> %s\n' "$*"; }
envval() { grep -E "^$1=" "$CHURN_REPO/.env" | head -1 | cut -d= -f2-; }

for bin in gcloud terraform kubectl helm docker; do command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }; done
gcloud auth application-default print-access-token >/dev/null 2>&1 || { echo "run: gcloud auth application-default login"; exit 1; }
[ -f "$ROOT/infra/terraform/terraform.tfvars" ] || { echo "create infra/terraform/terraform.tfvars with project_id"; exit 1; }
[ -f "$ROOT/data/deploy/index/thumbnails.bin" ] || python3 "$ROOT/scripts/package_index.py"
docker compose -f "$CHURN_REPO/docker-compose.yml" ps db --format '{{.State}}' 2>/dev/null | grep -q running \
  || { echo "start the churn repo's local db first: (cd $CHURN_REPO && docker compose up -d db)"; exit 1; }

step "1/9 terraform apply (GKE, Artifact Registry, GCS, workload identity, GitHub federation)"
$TF init -input=false >/dev/null
$TF apply -auto-approve -input=false
out() { $TF output -raw "$1"; }
PROJECT=$(out project_id); REGION=$(out region); REG=$(out registry); BUCKET=$(out index_bucket)
GSA=$(out backend_gcp_service_account); BUILDER=$(out builder_service_account)
eval "$(out get_credentials)"

# turn on CD: deploy-gke.yml in each repo runs only while these repo variables exist
if command -v gh >/dev/null && GH_TOKEN="$(gh auth token --user "${GH_USER:-agrimsharma}" 2>/dev/null)"; then
  for repo in celebrity-doppelganger saas-churn-platform; do
    for kv in "GCP_PROJECT=$PROJECT" "GCP_REGION=$REGION" "GKE_CLUSTER=$(out cluster_name)" "GKE_ZONE=$(out zone)" \
              "GAR_REGISTRY=$REG" "GCP_WIF_PROVIDER=$(out github_wif_provider)" \
              "GCP_DEPLOY_SA=$(out github_deployer_service_account)" "GCP_BUILD_SA=$BUILDER"; do
      GH_TOKEN="$GH_TOKEN" gh variable set "${kv%%=*}" -R "${GH_USER:-agrimsharma}/$repo" -b "${kv#*=}" >/dev/null
    done
  done
  echo "CD enabled: pushes to main now deploy to this cluster"
else
  echo "(gh not logged in as ${GH_USER:-agrimsharma}: CD stays off; this script still deploys directly)"
fi

step "2/9 images -> $REG (Cloud Build, amd64, tag $TAG; the 4 builds run in parallel)"
build() {  # build <context> <dockerfile relative to context> <image> [docker build args...]
  local ctx=$1 dockerfile=$2 image=$3; shift 3
  local cfg; cfg=$(mktemp -t cloudbuild).yaml
  {
    echo "steps:"
    echo "  - name: gcr.io/cloud-builders/docker"
    printf '    args: ["build", "-t", "%s", "-f", "%s"' "$REG/$image:$TAG" "$dockerfile"
    for a in "$@"; do printf ', "%s"' "$a"; done
    echo ', "."]'
    echo "images: [\"$REG/$image:$TAG\"]"
    echo "options: {logging: CLOUD_LOGGING_ONLY, machineType: E2_HIGHCPU_8}"
    echo "timeout: 1800s"
  } > "$cfg"
  gcloud builds submit "$ctx" --config "$cfg" --region "$REGION" --project "$PROJECT" \
    --service-account "projects/$PROJECT/serviceAccounts/$BUILDER" --quiet >/dev/null \
    && echo "  built $image" || { echo "  FAILED $image"; return 1; }
}
BUILDS=()
build "$ROOT" backend/Dockerfile doppelganger-backend & BUILDS+=($!)
build "$ROOT/frontend" Dockerfile doppelganger-frontend & BUILDS+=($!)
build "$CHURN_REPO" service/Dockerfile churn-api --build-arg WITH_NLP=true & BUILDS+=($!)
build "$CHURN_REPO" dashboard/Dockerfile churn-dashboard & BUILDS+=($!)

step "3/9 face index -> private GCS bucket (~1 GB, while the images build)"
gcloud storage rsync --recursive "$ROOT/data/deploy/index" "gs://$BUCKET/index" --quiet

step "4/9 ingress-nginx (public load balancer)"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update ingress-nginx jetstack >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --wait --timeout 10m >/dev/null
for _ in $(seq 1 60); do
  IP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [ -n "$IP" ] && break; sleep 5
done
DOMAIN="$IP.sslip.io"   # wildcard DNS: <anything>.<ip>.sslip.io resolves to the ip - no domain to buy
echo "ingress: $IP  ->  *.$DOMAIN"

step "5/9 cert-manager + Let's Encrypt"
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set crds.enabled=true --wait --timeout 10m >/dev/null
EMAIL=$(gcloud config get-value account 2>/dev/null)
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

step "6/9 Prometheus + Grafana"
GRAFANA_HOST="grafana.$DOMAIN" GRAFANA_TLS=1 "$ROOT/infra/monitoring/install.sh"

echo "  waiting for the image builds..."
for pid in "${BUILDS[@]}"; do   # a bare `wait` would report success even if a build failed
  wait "$pid" || { echo "an image build failed - see: gcloud builds list --region $REGION"; exit 1; }
done

step "7/9 doppelganger"
helm upgrade --install doppelganger "$ROOT/infra/helm/doppelganger" -n doppelganger --create-namespace \
  -f "$ROOT/infra/helm/doppelganger/values-gke.yaml" \
  --set backend.image.repository="$REG/doppelganger-backend" --set backend.image.tag="$TAG" \
  --set frontend.image.repository="$REG/doppelganger-frontend" --set frontend.image.tag="$TAG" \
  --set index.gcs.bucket="$BUCKET" \
  --set serviceAccount.annotations."iam\.gke\.io/gcp-service-account"="$GSA" \
  --set ingress.host="doppelganger.$DOMAIN" \
  --set-string backend.apiKey="$(openssl rand -hex 16)" \
  --wait --timeout 15m >/dev/null

step "8/9 churn platform"
helm upgrade --install churn "$CHURN_REPO/deploy/helm/churn-platform" -n churn --create-namespace \
  -f "$CHURN_REPO/deploy/helm/churn-platform/values-gke.yaml" \
  --set api.image.repository="$REG/churn-api" --set api.image.tag="$TAG" \
  --set dashboard.image.repository="$REG/churn-dashboard" --set dashboard.image.tag="$TAG" \
  --set api.complaintsModel.hub="$COMPLAINTS_MODEL_REPO" \
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

Recording checklist: infra/session/RECORDING.md.  When done:  ./infra/session/down-gcp.sh
DONE
