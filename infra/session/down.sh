#!/usr/bin/env bash
# Destroy the whole session environment (cluster, registry, storage, identities, budget).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# turn CD off first, so a push can't try to deploy to a cluster that's being deleted
if command -v gh >/dev/null && GH_TOKEN="$(gh auth token --user "${GH_USER:-agrimsharma}" 2>/dev/null)"; then
  for repo in celebrity-doppelganger saas-churn-platform; do
    for v in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AKS_RG AKS_NAME ACR_NAME; do
      GH_TOKEN="$GH_TOKEN" gh variable delete "$v" -R "${GH_USER:-agrimsharma}/$repo" >/dev/null 2>&1 || true
    done
  done
fi
terraform -chdir="$ROOT/infra/azure" destroy -auto-approve -input=false
kubectl config delete-context portfolio-aks >/dev/null 2>&1 || true
echo "Destroyed. Check nothing is left: az group list -o table"
