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

echo "==> 2/4 images -> $IMAGE:$TAG, ${IMAGE%/*}/frontend:$TAG"
gcloud auth configure-docker "$REGISTRY_HOST" --quiet
docker build --platform linux/amd64 -f "$ROOT/backend/Dockerfile" -t "$IMAGE:$TAG" "$ROOT"
docker build --platform linux/amd64 -t "${IMAGE%/*}/frontend:$TAG" "$ROOT/frontend"
docker push "$IMAGE:$TAG" && docker push "${IMAGE%/*}/frontend:$TAG"

echo "==> 3/4 kubectl credentials"
eval "$(tf get_credentials)"

echo "==> 4/4 helm upgrade"
helm upgrade --install doppelganger "$ROOT/infra/helm/doppelganger" \
  --namespace "$NAMESPACE" --create-namespace -f "$ROOT/infra/helm/doppelganger/values-gke.yaml" \
  --set backend.image.repository="$IMAGE" --set backend.image.tag="$TAG" \
  --set frontend.image.repository="${IMAGE%/*}/frontend" --set frontend.image.tag="$TAG" \
  --set index.gcs.bucket="$BUCKET" \
  --set serviceAccount.annotations."iam\.gke\.io/gcp-service-account"="$GSA" \
  --set ingress.gce.staticIpName="$IP_NAME" \
  --set backend.apiKey="$API_KEY" \
  --wait --timeout 10m

echo
echo "App: http://$(tf ingress_ip)/  (the load balancer can take ~10 min to go live)"
