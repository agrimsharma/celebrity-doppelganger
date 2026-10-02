# Recording session (GKE, one sitting)

Goal: screen recordings + screenshots of the **full** product for both projects, then destroy
everything the same day. Runs on GKE (free-trial credit, roughly ₹200-400 for the day); `down-gcp.sh`
at the end. The AKS path (`up.sh` / `down.sh`) is the same flow on Azure.

Record with QuickTime (File → New Screen Recording) or `Cmd+Shift+5`. Keep clips short (30–90 s)
and name them `NN-what.mov` as you go.

## Before (the day before, 15 min)

- [ ] Rehearse locally: `./infra/local/kind-up.sh`, deploy both charts, click through once
- [x] Hugging Face: complaints model published (agrim-sharma/cfpb-complaints-distilbert)
- [ ] Optional: a free Slack workspace + incoming webhook in the churn `.env` (`SLACK_WEBHOOK_URL`)
- [ ] Churn repo: `docker compose up -d db` (the complaint index is copied from it)
- [ ] Close other apps; set the browser zoom to 110–125% so text is readable in recordings

## Session

```bash
gcloud auth login && gcloud auth application-default login     # your own account (Owner on the project)
(cd ../saas-churn-platform && docker compose up -d db)            # the complaint index is copied from it
./infra/session/up-gcp.sh
```

### 1. Infrastructure as code (terminal)
- [ ] `01-terraform`: the `terraform apply` plan summary and "Apply complete" (GKE, Artifact Registry, GCS, workload identity, GitHub federation)
- [ ] `02-cluster`: `kubectl get nodes -o wide`, `kubectl get pods -A`
- [ ] `03-helm`: `helm list -A` (ingress-nginx, cert-manager, monitoring, doppelganger, churn)
- [ ] Screenshot: GCP console → Kubernetes Engine → Workloads, and Cloud Build history (the 4 parallel builds)

### 2. Doppelganger
- [ ] `04-dopp-upload`: open `https://doppelganger.<ip>.sslip.io` (show the padlock), upload a photo → results
- [ ] `05-dopp-camera`: "Use camera" → live preview → take photo → results
- [ ] `06-dopp-workload-identity`: `kubectl -n doppelganger logs deploy/doppelganger-backend -c fetch-index`
      (the index pulled from the private GCS bucket with no keys) and the ServiceAccount annotation
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

### 4. CI/CD
- [ ] `13-cicd`: make a visible one-line change (e.g. the subtitle in `frontend/app/page.tsx`), push to
      `main`, show the "Deploy to GKE" run in GitHub Actions (Workload Identity Federation login, Cloud Build, helm rollout), then
      reload the live site with the change

### 5. Wrap-up
- [ ] `14-teardown`: `./infra/session/down-gcp.sh` → "Destroy complete" and "Nothing left"
- [ ] GCP console → Billing → Reports: screenshot of the day's cost (covered by trial credit)
- [ ] Then the account owner closes the billing account (Billing → Account management)

## After

Trim the clips, upload to YouTube (unlisted) or keep as GIFs in the READMEs; the free Vercel + Modal
links stay live permanently.
