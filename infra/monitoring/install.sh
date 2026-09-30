#!/usr/bin/env bash
# Prometheus + Grafana (kube-prometheus-stack). Grafana at http://$GRAFANA_HOST (default
# grafana.localtest.me:8080 on kind). Admin password is generated once and kept in a Secret.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GRAFANA_HOST="${GRAFANA_HOST:-grafana.localtest.me}"
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if ! kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then
  kubectl -n monitoring create secret generic grafana-admin \
    --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -hex 12)" >/dev/null
fi
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community >/dev/null
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring -f "$HERE/values.yaml" \
  --set grafana.admin.existingSecret=grafana-admin \
  --set "grafana.ingress.hosts[0]=$GRAFANA_HOST" \
  ${GRAFANA_TLS:+--set "grafana.ingress.tls[0].hosts[0]=$GRAFANA_HOST" --set "grafana.ingress.tls[0].secretName=grafana-tls" --set "grafana.ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt"} \
  --wait --timeout 10m >/dev/null
echo "Grafana: http://$GRAFANA_HOST  (user admin; password: kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
