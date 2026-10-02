#!/usr/bin/env bash
# Delete the whole GKE session environment, in an order that leaves nothing billable behind.
# Load balancers and persistent disks are created by Kubernetes, not Terraform, so deleting only
# the cluster could orphan them: remove the namespaces first, let GKE clean those up, then destroy.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF="terraform -chdir=$ROOT/infra/terraform"
PROJECT=$($TF output -raw project_id 2>/dev/null || awk -F'"' '/project_id/{print $2}' "$ROOT/infra/terraform/terraform.tfvars")

echo "==> 1/4 turn CD off (so a push can't deploy into a cluster being deleted)"
if command -v gh >/dev/null && GH_TOKEN="$(gh auth token --user "${GH_USER:-agrimsharma}" 2>/dev/null)"; then
  for repo in celebrity-doppelganger saas-churn-platform; do
    for v in GCP_PROJECT GCP_REGION GKE_CLUSTER GKE_ZONE GAR_REGISTRY GCP_WIF_PROVIDER GCP_DEPLOY_SA GCP_BUILD_SA; do
      GH_TOKEN="$GH_TOKEN" gh variable delete "$v" -R "${GH_USER:-agrimsharma}/$repo" >/dev/null 2>&1 || true
    done
  done
fi

echo "==> 2/4 delete workloads (releases the load balancer and the PVC disks)"
if eval "$($TF output -raw get_credentials 2>/dev/null)" >/dev/null 2>&1; then
  kubectl delete namespace churn doppelganger monitoring cert-manager --ignore-not-found --wait --timeout=10m
  kubectl delete namespace ingress-nginx --ignore-not-found --wait --timeout=10m   # the LoadBalancer service
  for _ in $(seq 1 30); do   # wait until GKE has actually released the forwarding rule
    [ -z "$(gcloud compute forwarding-rules list --project "$PROJECT" --format='value(name)' 2>/dev/null)" ] && break
    sleep 10
  done
fi

echo "==> 3/4 terraform destroy (cluster, registry + images, bucket + index, service accounts, federation)"
$TF destroy -auto-approve -input=false
gcloud storage rm --recursive "gs://${PROJECT}_cloudbuild" --quiet >/dev/null 2>&1 || true   # build source uploads

echo "==> 4/4 anything left that could bill?"
left=0
for kind in "compute instances" "compute disks" "compute forwarding-rules" "compute addresses" "container clusters"; do
  items=$(gcloud $kind list --project "$PROJECT" --format='value(name)' 2>/dev/null)
  if [ -n "$items" ]; then echo "  LEFT: $kind -> $items"; left=1; fi
done
for ctx in $(kubectl config get-contexts -o name 2>/dev/null | grep "gke_${PROJECT}_"); do
  kubectl config delete-context "$ctx" >/dev/null 2>&1
done
[ "$left" = 0 ] && echo "Nothing left. Your friend can now close the billing account (Billing -> Account management)." \
                || echo "Delete the items above (or re-run this script) before closing the billing account."
