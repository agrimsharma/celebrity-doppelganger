# Recording session (AKS, one sitting)

Goal: screen recordings + screenshots of the **full** product for both projects, then destroy
everything the same day. Free-account credit is used (~$5–15 for the day); `down.sh` at the end.

Record with QuickTime (File → New Screen Recording) or `Cmd+Shift+5`. Keep clips short (30–90 s)
and name them `NN-what.mov` as you go.

## Before (the day before, 15 min)

- [ ] Rehearse locally: `./infra/local/kind-up.sh`, deploy both charts, click through once
- [ ] Hugging Face: complaints model published (`scripts/publish_hf.py` in the churn repo) so
      `COMPLAINTS_MODEL_REPO=<you>/cfpb-complaints-distilbert` is set for up.sh
- [ ] Optional: a free Slack workspace + incoming webhook in the churn `.env` (`SLACK_WEBHOOK_URL`)
- [ ] Churn repo: `docker compose up -d db` (the complaint index is copied from it)
- [ ] Close other apps; set the browser zoom to 110–125% so text is readable in recordings

## Session

```bash
az login
cp infra/azure/terraform.tfvars.example infra/azure/terraform.tfvars   # subscription id + email
COMPLAINTS_MODEL_REPO=<you>/cfpb-complaints-distilbert ./infra/session/up.sh
```

### 1. Infrastructure as code (terminal)
- [ ] `01-terraform`: the `terraform apply` plan summary and "Apply complete" (AKS, ACR, storage, workload identity, budget)
- [ ] `02-cluster`: `kubectl get nodes -o wide`, `kubectl get pods -A`
- [ ] `03-helm`: `helm list -A` (ingress-nginx, cert-manager, monitoring, doppelganger, churn)
- [ ] Screenshot: Azure portal → resource group (all resources) and the AKS "Workloads" blade

### 2. Doppelganger
- [ ] `04-dopp-upload`: open `https://doppelganger.<ip>.sslip.io` (show the padlock), upload a photo → results
- [ ] `05-dopp-camera`: "Use camera" → live preview → take photo → results
- [ ] `06-dopp-workload-identity`: `kubectl -n doppelganger logs deploy/doppelganger-backend -c fetch-index`
      (the index pulled from private Blob storage with no keys) and the ServiceAccount annotation
- [ ] `07-autoscaling` (split screen: terminal + Grafana):
      `kubectl -n doppelganger get hpa -w` in one pane,
      `k6 run -e BASE_URL=https://doppelganger.<ip>.sslip.io -e IMAGE=<selfie.jpg> infra/loadtest/match.js` in another,
      Grafana "Doppelganger" dashboard: requests/s, p95 latency, replicas going 1 → 2
- [ ] Screenshot: k6 summary (requests, 0% errors, p95)

### 3. Churn platform
- [ ] `08-churn-dashboard`: `https://churn.<ip>.sslip.io` → score a batch, drift check, backtest tab
- [ ] `09-n8n-retention`: n8n → "daily retention scoring" → Execute workflow → show the canvas turning green,
      then the Slack digest (if configured) and the dashboard's Workflow activity tab
- [ ] `10-rag-live`: send a complaint to the webhook and show the routed ticket with similar cases and the
      **live Claude draft**:
      ```bash
      curl -s -X POST https://n8n.<ip>.sslip.io/webhook/complaint -H 'Content-Type: application/json' \
        -d '{"text":"Someone opened a credit card in my name and it now shows as delinquent on my credit report."}' | jq
      ```
- [ ] `11-drift-retrain`: n8n → "weekly drift check & retrain" → Execute → promoted/rejected result
- [ ] `12-api-docs`: `https://churn-api.<ip>.sslip.io/docs` (FastAPI Swagger)
- [ ] Screenshot: Grafana "Churn platform" dashboard (latency by route, predictions, drift mass, Claude tokens)

### 4. Wrap-up
- [ ] `13-teardown`: `./infra/session/down.sh` → "Destroy complete"
- [ ] Azure portal → Cost Management: screenshot of the day's cost
- [ ] `az group list -o table` shows nothing left

## After

Trim the clips, upload to YouTube (unlisted) or keep as GIFs in the READMEs; the free Hugging Face +
Vercel links stay live permanently.
