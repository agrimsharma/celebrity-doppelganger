#!/usr/bin/env bash
# Local rehearsal cluster (kind = Kubernetes in Docker) for BOTH projects - free, no cloud account.
# Same Helm charts as AKS; only the values file differs (images loaded locally, data from host
# folders instead of cloud storage).
#   ./infra/local/kind-up.sh          # cluster + ingress-nginx + metrics-server + monitoring
#   ./infra/local/kind-down.sh        # delete it
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHURN_REPO="${CHURN_REPO:-$ROOT/../saas-churn-platform}"
CLUSTER="${CLUSTER:-portfolio}"

kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --config - <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    labels:
      ingress-ready: "true"
    extraPortMappings:           # ingress on http://*.localtest.me:8080 (resolves to 127.0.0.1)
      - {containerPort: 80, hostPort: 8080, protocol: TCP}
      - {containerPort: 443, hostPort: 8443, protocol: TCP}
    extraMounts:                 # stand-ins for cloud storage
      - {hostPath: "$ROOT/data/deploy/index", containerPath: /mnt/dopp-index, readOnly: true}
      - {hostPath: "$CHURN_REPO/models/complaints-classifier", containerPath: /mnt/churn-models/complaints-classifier, readOnly: true}
YAML
kubectl config use-context "kind-$CLUSTER" >/dev/null

echo "==> ingress-nginx"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml >/dev/null
# anything with an Ingress is rejected until the controller's admission webhook is up
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s >/dev/null
echo "==> metrics-server (for the HPA)"
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system \
  --set 'args={--kubelet-insecure-tls}' --wait >/dev/null
if [ "${MONITORING:-1}" = 1 ]; then
  echo "==> kube-prometheus-stack (Prometheus + Grafana)"
  "$ROOT/infra/monitoring/install.sh"
fi
echo "Cluster '$CLUSTER' ready. Apps: http://<name>.localtest.me:8080  Grafana: http://grafana.localtest.me:8080"
