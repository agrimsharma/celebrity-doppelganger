# Technical Design Doc: Celebrity Doppelganger Finder

**Status:** Draft v3 — backend target pivoted twice, see banners below
**Depends on:** [PRD.md](./PRD.md) (D1–D4, G3 in particular — G3's "$0 ongoing" goal is
superseded by the pivot, see banners)
**Last updated:** 2026-09-06

---

## Pivot banner #2 (2026-09-06) — cloud provider: AWS/EKS → GCP/GKE

**Superseding banner #1 below before EKS was ever built.** While researching AWS account setup,
the user hit real friction: AWS's current account creation flow ties even the "Free Plan" into
autopay/billing setup, not just card verification. Cost research done in this session found a
better fit: **GKE gives a $74.40/month credit per billing account that fully offsets one zonal
(or Autopilot) cluster's control-plane fee, indefinitely — not a time-boxed trial.** EKS's
control plane, by contrast, is a flat ~$0.10/hr (~$73/month) with no free equivalent. GKE also
literally matches the target JD's "EKS/GKE" wording (banner #1's rationale, unchanged). AKS
(Azure) was also considered — its free-tier control plane is genuinely $0/hr — but wasn't chosen
since it doesn't match the JD's literal wording as directly as GKE does; it's a reasonable
fallback if GCP account setup turns out to have its own friction.

**Everything below written under banner #1 (EKS/Terraform/Helm) should be read as
EKS→GKE, ECR→Artifact Registry, IAM/OIDC/IRSA→GCP Workload Identity Federation, ALB Controller→
GCE Ingress controller.** The Terraform/Helm/container-bundling *shape* of the design is
unchanged — only the cloud provider underneath it is. §11 below has been updated in place to
reflect this; nothing has actually been built yet under either version, so there's no rework
cost from the switch.

## Pivot banner #1 (2026-09-06, superseded by #2 above)

**The Lambda backend described in §3–4 and §8 below was never built and is no longer the
plan.** The backend target changed to **Kubernetes + Terraform + Helm**, decided in order
to demonstrate exactly those skills for a specific target job (Sr. ML Platform Engineer @
talabat/Delivery Hero, Dubai) — not because anything about the Lambda design was technically
wrong. Full rationale lives in [HANDOFF.md](./HANDOFF.md) §7; the replacement design is in the
new §11 below. **§1–2 and §5–7 (free-tier research, embedding sizing, upload handling, batch
pipeline outcome, frontend choice) are unaffected by the pivot and still apply as-is.** §3, §4,
and §8 are kept below for historical record (they explain *why* the Lambda-container design
looked attractive) but describe a path that is not being built.

**Real consequence of the pivot, stated plainly:** PRD G3 ("$0 ongoing hosting cost") is no
longer fully met even under GKE (see banner #2) — a running worker-node VM still costs something
on any cloud, since none of the providers' small perpetual-free compute tiers comfortably fit
this workload's model+embeddings+thumbnails bundle. This is an accepted, deliberate tradeoff
(K8s/Terraform/Helm resume signal for the target role matters more than $0 hosting for this
project), not an oversight — see §11 for the cost mitigation plan.

## 1. Free-tier facts this design relies on (verified, not assumed)

AWS overhauled its free tier in July 2025. New accounts pick a **Free Plan** (credits, auto-closes
after 6 months) or **Paid Plan** (pay-as-you-go), but **"Always Free"** usage limits apply on
either plan and don't expire. Checked directly against AWS's own free-tier pages and cross-checked
against independent write-ups (Aug 2026):

| Service | Status | Limit |
|---|---|---|
| **Lambda** | **Confirmed Always Free** | 1M requests/month + 400,000 GB-seconds compute/month |
| **DynamoDB** | **Confirmed Always Free** | 25GB storage + 25 WCU/RCU |
| **EventBridge (scheduled rules)** | Confirmed Always Free (standard tier) | generous invocation limits |
| **S3** | **Unconfirmed / conflicting sources** | "5GB, 20K GET, 2K PUT" shows up in both an "Always Free" list and a "12-months-only" list depending on the source |
| **CloudFront** | **Unconfirmed / conflicting sources** | similarly inconsistent across sources |
| **API Gateway** | Not part of Always Free (12-month-only historically) | avoided by design, see §4 |
| **ECR (container storage)** | Free tier exists but is small/time-limited | relevant if we ship Lambda as a container image |

**Design implication:** anything load-bearing for G3 ($0 *ongoing*) should lean on Lambda +
DynamoDB, which are solidly free forever. Where S3 shows up, it's for genuinely tiny, low-volume
data — not the bulk dataset — so even a worst-case "it wasn't actually always-free" outcome costs
cents/month, not dollars. Bake in an **AWS Budgets alert at $2/month** regardless, so an incorrect
free-tier assumption gets caught immediately instead of silently accumulating.

Sources: [AWS Free Tier](https://aws.amazon.com/free/), [AWS Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/), [AWS Free Tier 2026 guide](https://agentdeals.dev/aws-free-tier-2026), [AWS Free Tier changes explainer](https://infratally.com/articles/aws-free-tier-2026/)

## 2. Embedding & index sizing (the numbers that resolve PRD Risk on D1)

- Model: `insightface` (ArcFace, `buffalo_l`) — already installed and validated locally
  (`face-rec` venv). Output: 512-dim float embedding per face.
- Full dataset: 523,051 images → 523,051 vectors.
- Storage at float32: 523,051 × 512 × 4 bytes ≈ **1.07GB**.
- Storage at float16 (sufficient precision for cosine similarity matching): ≈ **535MB**.

**This resolves the PRD's D1 risk more favorably than expected.** The concern was "will 523k
vectors fit in free-tier RAM" — at ~535MB (float16) it comfortably fits in a single Lambda
invocation's memory (Lambda supports up to 10GB). The full dataset was never actually the
bottleneck; the 8GB figure that made this feel risky was the *images*, not the *embeddings*.

**Search method:** at this size, brute-force cosine similarity (one matrix-vector multiply,
523,051 × 512) is under ~50ms on any modern CPU — an approximate-NN index (FAISS/HNSW) is not
required for performance. Recommend building it with **FAISS (`IndexFlatIP`, later swappable to
HNSW)** anyway, specifically because "vector index at 500k+ scale" is the resume-relevant skill —
brute-force numpy would technically work but doesn't demonstrate the same thing.

## 3. What actually needs to be "hosted" vs "shipped in the deployment" (SUPERSEDED — see §11)

The 8GB of face crops is the real size problem, not the embeddings. Rather than solve "host 8GB
of images for free forever" as an open question, sidestep it:

- Resize every face crop to a small display thumbnail (e.g. 160×160 JPEG, ~5–8KB each).
  523,051 × ~7KB ≈ **3.5GB**, down from 8GB.
- **Bundle the thumbnails + the FAISS index + the ONNX model files directly into the Lambda
  container image** (Lambda supports container images up to 10GB via ECR). Rough budget: ~3.5GB
  thumbnails + ~535MB index + ~300MB model + app code ≈ **4.5GB**, comfortably under the 10GB cap.

This means the query path **never calls S3 at all** for the core matching flow — it's one Lambda
invocation, self-contained. That deliberately avoids depending on S3/CloudFront's ambiguous
free-tier status for the expensive part of the system.

## 4. Query API (SUPERSEDED — see §11)

- **AWS Lambda, packaged as a container image**, with a **Lambda Function URL** (a direct HTTPS
  endpoint attached to the function — no API Gateway, so its free-tier ambiguity is a non-issue).
- Request: uploaded photo (base64 in the request body).
- Processing: detect face → embed (insightface) → brute-force cosine similarity against the
  bundled 277,752-vector array (~10ms measured, no ANN index needed — see §6) → return top-K
  (K configurable per PRD D4) celebrity name + bundled thumbnail + score.
- **Cold starts are the real risk against the PRD's "<5s" success metric** — a container with a
  ~4.5GB data layer plus model load will cold-start slower than a trivial function. Mitigation:
  Docker layer caching keeps the data layer separate from the code layer (data rarely changes, so
  it stays cached across deploys), and an optional free external cron ping (e.g. a free
  cron-job.org ping every 5–10 min hitting the Function URL) keeps one instance warm — this costs
  a trivial number of the 1M free monthly requests and is a real technique, not a hack. Needs
  measurement once built; if cold start is still too slow, EventBridge-triggered self-pings
  (also Always Free tier) are the AWS-native alternative to the external cron ping.

## 5. Uploaded-photo handling — revisiting PRD G4/D-choice

PRD chose "store temporarily with expiry" over "process and discard." Flagging before building
this: since the Lambda approach processes the upload entirely in memory during a single
invocation and never needs to persist it to compute the match, **the simplest implementation is
actually pure in-memory processing with zero persistence** — which trivially satisfies "don't keep
user photos" and removes an entire subsystem (storage + expiry/cleanup job) from scope.

**RESOLVED (PRD D5): real store+expiry+deletion is wanted eventually, but deferred.** v1 ships
with pure in-memory processing (satisfies "don't keep photos" trivially). The S3-with-lifecycle-
rule version becomes a v1.1 feature once the core product is live.

## 6. Batch embedding pipeline — RESOLVED (actual outcome, 2026-08-24)

Neither of the two options originally planned here (distributed Lambda fan-out, or slow local
CPU) is what actually happened. **A rented GPU instance (vast.ai, RTX 3060 Ti) turned out to be
the better path**: ~0.011s/img on GPU vs ~0.55s/img on the local laptop CPU (~50x), which let the
*entire* dataset run in a couple hours for a few dollars of instance time, no distributed
orchestration needed.

**Final result: 277,752 embeddings** (27,753 WIKI + 249,999 IMDB) out of 442,733 usable images
(523,051 raw) — the shortfall from "usable" to "embedded" is the 0.75 detector-confidence filter
doing its job (WIKI ~15% rejected, IMDB ~37% rejected — IMDB's movie-still images are lower
quality on average, a real property of the source data, not a bug).

**Also resolved: FAISS/ANN indexing turned out to be unnecessary.** Measured brute-force cosine
similarity (one matrix-vector multiply) against all 277,752 vectors: **~10ms**. At this scale a
fancy vector index would be solving a problem that doesn't exist — simple `embeddings @ query`
is plenty fast. Keeping this in mind for the writeup: "evaluated vector-index options, measured
that brute-force search was sufficient at this scale" is a more honest and still-legitimate
engineering story than bolting on FAISS for its own sake.

**Distributed batch processing on AWS (the original "master scalability" pitch) did not end up
happening** — it turned out not to be the bottleneck once GPU compute was available. This is worth
being upfront about rather than retrofitting a Lambda fan-out job we don't actually need: the
real scalability/engineering story in this project is elsewhere (277K-vector search sub-image
latency, cross-machine reproducible embedding pipeline, GPU vs CPU cost/speed tradeoff analysis)
and that's a perfectly legitimate story to tell.

## 7. Frontend

- Node.js-based app (Express or Next.js — Next.js gives a slightly more modern resume line and
  makes the upload UI trivial; Express is lighter and more transparent for interview walkthroughs).
  Recommend **Next.js**, minimal use of its features (no need for SSR complexity here) — mainly for
  the resume signal and because deploying it is simple.
- Calls the Lambda Function URL directly from the browser (CORS enabled on the function).

**RESOLVED (PRD D7): a free external platform, not S3+CloudFront.** Recommend **Vercel**
specifically — it's the natural pairing for Next.js (zero-config deploy from a GitHub repo, no
Dockerfile/build config needed) and its free tier comfortably covers a low-traffic demo.

## 8. Cost summary (SUPERSEDED — see §11 for actual EKS cost picture)

| Component | Service | Free-tier confidence | Worst-case residual cost |
|---|---|---|---|
| Query API compute | Lambda | Confirmed Always Free | $0 (well under 1M req/month at demo traffic) |
| Index + thumbnails + model storage | Bundled in Lambda container image | N/A (ships with deploy, not a running storage service) | ECR image storage — small, time-limited free tier, then a couple cents/month for ~4.5GB |
| API endpoint | Lambda Function URL | Part of Lambda, no separate charge | $0 |
| Upload handling | In-memory (or small S3 bucket if history feature wanted) | Confirmed $0 / low-volume S3 | $0 or negligible |
| Batch job (one-time) | Lambda (Option A) or local (Option B) | Always Free / genuinely $0 | $0 |
| Frontend hosting | S3+CloudFront or free platform | Ambiguous / Confirmed depending on choice | $0–low cents |
| Safety net | AWS Budgets alert | Free | catches any surprise early |

Realistic worst case across the whole system: **a few cents a month**, not the dollars per month a
naive "store 8GB in S3 + serve via CloudFront" design would risk. That's the main reason for
bundling data into the container image instead of relying on S3/CloudFront for the bulk data.

## 9. Resolved decisions (2026-08-21)

1. **Upload persistence:** the real store+expire+delete feature is confirmed as wanted, but
   **deferred** — build it after matching quality is validated (§10). Until then, uploads are
   processed in-memory only (a strict subset of the eventual behavior, not a contradiction of it).
2. **Batch pipeline order:** **local-first** (Option B) — get the pipeline and match quality
   validated fast; the distributed-Lambda version (Option A) is a later upgrade once the core
   approach is proven.
3. **Frontend hosting: a free external platform** (Vercel/GitHub Pages), not S3+CloudFront.

## 10. Build sequencing — matching quality before infra

Per PRD D6: nothing in §3–8 above gets built yet. First phase is proving the matching pipeline
itself works and produces results that feel right, entirely locally:

1. Confirm what already exists locally (prior `face-rec`/`insightface` experiments,
   `face_match_matrix.csv`, `batch_embeddings_results.json`, notebooks, any partial IMDB-WIKI
   download) before writing anything new.
2. Get the IMDB-WIKI cropped-faces set (or a large enough working subset) available locally.
3. Run face detection + embedding (insightface) over it, store embeddings.
4. Build a small local script/notebook: embed a test photo, find nearest neighbor(s), inspect
   results.
5. Iterate on quality — this is the actual unknown in the project (does ArcFace-style similarity
   on this specific, quite old/inconsistent-quality dataset produce matches that feel like real
   "doppelgangers," or just same-demographic near-misses?). Only once this is satisfying does the
   AWS/Lambda/frontend work in §3–8 start.

**Status: this phase is done.** Matching quality was validated locally (see §6, and HANDOFF.md
§2–3) — 150,720 cleaned embeddings after the duplicate-image fix, calibrated similarity scoring,
brute-force cosine search at ~10ms. The frontend (§7) was also built and is running against
`scripts/local_api_server.py` as a local stand-in backend. Only the real backend (§11 below)
remains.

## 11. Backend design (CURRENT — Kubernetes (GKE) + Terraform + Helm)

Replaces §3–4 and §8. Updated under banner #2 (GCP, not AWS — see above). Same matching logic as
`scripts/local_api_server.py` (detect → embed via insightface → brute-force cosine search over
the 150,720-vector consolidated array → calibrated top-3 with name dedup), but packaged and
deployed differently:

- **Containerize** `local_api_server.py`'s logic (or a rewritten equivalent — e.g. FastAPI, still
  TBD) into a Docker image bundling the model weights, `embeddings.npy`, `manifest.csv`, and
  `thumbnails/`. Same bundling rationale as the old §3 (self-contained image, no separate data
  store to serve at request time) — only the runtime target changes, not this part of the
  reasoning.
- **Infra: Terraform** provisions a **GKE cluster** (VPC/subnet, node pool, Workload Identity
  Federation for pod-level GCP permissions, the GKE control plane itself — using a **zonal**
  cluster specifically, since that's what the free-tier credit in banner #2 applies to, not a
  regional one) — this *is* the resume-relevant deliverable, not an implementation detail to
  minimize.
- **Deploy: Helm chart** wrapping a Kubernetes `Deployment` (the containerized matcher),
  `Service`, and `Ingress` (GKE's native Ingress-to-Google-Cloud-Load-Balancer integration, or a
  plain `LoadBalancer` Service — open sub-decision at build time) to get a public HTTPS endpoint.
- **Container registry: Artifact Registry** (GCP's equivalent of ECR) for the built image.
- **Cost reality (see Pivot banner #2 above):** the GKE control plane fee is offset to $0 by the
  per-billing-account monthly credit **as long as this stays a single zonal/Autopilot cluster**
  — running a second cluster, or switching to regional, would start incurring the $0.10/hr fee
  for real. Worker-node VM cost is separate and not covered by that credit; still mitigate with
  `terraform destroy` between demo sessions and a GCP budget alert (~$10–20/month), same
  discipline as the original EKS plan called for.
- **Not yet decided at time of writing** (resolve when this milestone actually starts): exact
  Ingress/LoadBalancer approach, whether to rewrite `local_api_server.py` in a proper framework
  (FastAPI) or containerize it close to as-is, node pool sizing/machine type, and whether GKE
  Autopilot (less infra to manage, but less "I configured the node pool myself" resume detail) or
  Standard mode with a manually-sized node pool is used. None of these block starting the
  Terraform scaffolding for the cluster itself.
