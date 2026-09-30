#!/usr/bin/env bash
# End-to-end deploy to GKE. Prereqs: gcloud (authenticated), terraform, kubectl, helm, docker,
# and `terraform apply` already run in infra/terraform.
#
#   API_KEY=<shared secret> ./scripts/deploy.sh [image-tag]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-$(git -C "$ROOT" rev-parse --short HEAD)}"
NAMESPACE="doppelganger"
: "${API_KEY:?set API_KEY (the frontend sends it as X-API-Key)}"

tf() { terraform -chdir="$ROOT/infra/terraform" output -raw "$1"; }
IMAGE="$(tf image_repository)"
BUCKET="$(tf index_bucket)"
GSA="$(tf backend_gcp_service_account)"
IP_NAME="$(tf ingress_ip_name)"
REGISTRY_HOST="${IMAGE%%/*}"

echo "==> 1/4 index -> gs://$BUCKET/index"
[ -d "$ROOT/data/deploy/index" ] || python "$ROOT/scripts/package_index.py"
gcloud storage rsync --recursive "$ROOT/data/deploy/index" "gs://$BUCKET/index"

echo "==> 2/4 image -> $IMAGE:$TAG"
gcloud auth configure-docker "$REGISTRY_HOST" --quiet
docker build --platform linux/amd64 -f "$ROOT/backend/Dockerfile" -t "$IMAGE:$TAG" "$ROOT"
docker push "$IMAGE:$TAG"

echo "==> 3/4 kubectl credentials"
eval "$(tf get_credentials)"

echo "==> 4/4 helm upgrade"
helm upgrade --install doppelganger-backend "$ROOT/infra/helm/doppelganger-backend" \
  --namespace "$NAMESPACE" --create-namespace \
  --set image.repository="$IMAGE" --set image.tag="$TAG" \
  --set index.bucket="$BUCKET" \
  --set serviceAccount.gcpServiceAccount="$GSA" \
  --set ingress.staticIpName="$IP_NAME" \
  --set apiKey="$API_KEY" \
  --wait --timeout 10m

echo
echo "Backend: http://$(tf ingress_ip)/match  (load balancer can take ~10 min to go live)"
echo "Vercel env: BACKEND_URL=http://$(tf ingress_ip)/match  BACKEND_API_KEY=<same API_KEY>"
