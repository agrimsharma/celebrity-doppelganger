#!/usr/bin/env bash
# Destroy the whole session environment (cluster, registry, storage, identities, budget).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
terraform -chdir="$ROOT/infra/azure" destroy -auto-approve -input=false
kubectl config delete-context portfolio-aks >/dev/null 2>&1 || true
echo "Destroyed. Check nothing is left: az group list -o table"
