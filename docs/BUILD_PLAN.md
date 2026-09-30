# Build Plan: Frontend + Kubernetes Backend

**Status:** Draft v2 — Milestone 2 rewritten for the K8s+Terraform pivot
**Depends on:** [PRD.md](./PRD.md), [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) §11 (both up to
date as of 2026-09-06)

---

## Pivot note (2026-09-06, updated same day — second pivot)

Milestone 2 below (originally "Lambda backend") targets **Kubernetes + Terraform + Helm** instead
of AWS Lambda — see the project decision log (kept private) §7 and [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md)
§11 for the why and the design. **Cloud provider within that: GKE (Google Cloud), not EKS (AWS)**
— switched the same day after cost research found AWS's account creation ties even its "Free
Plan" into autopay, and that GKE's per-billing-account monthly credit fully offsets one zonal
cluster's control-plane fee indefinitely (EKS has no equivalent — flat ~$0.10/hr always). See
Technical Design §11's Pivot banner #2 for the full comparison including Azure/AKS, which was
considered and passed over. Milestones 1, 3, 4, 5 are unaffected by either pivot and still apply
as written.

## Where we stand

Matching-quality validation (PRD D6) is done, and further hardened since: 150,720 clean face
embeddings after a duplicate-image data-quality fix (see the decision log §2), local match testing
looked good with calibrated similarity scoring, brute-force cosine search measured at ~10ms even
at this scale (no vector index needed — see Technical Design §6). Per-photo latency is ~1s
(detect+embed) once a model is warm. Milestone 1 (package artifacts) is also done. Milestone 3
(frontend) is built and iterated, running against the local dev backend
(`scripts/local_api_server.py`), not yet deployed. **Milestone 2 (real backend) is the one thing
not started.**

## Milestone 1 — Package the deployment artifacts

Everything currently lives as loose chunk files + full-size images on a local disk. Before this
can go in a Lambda container (10GB limit), it needs to shrink:

1. **Generate thumbnails**: resize all 277,752 reference images to ~160×160 JPEG (~5-8KB each,
   ~1.5-2.2GB total vs. the current ~15GB of full-size images).
2. **Consolidate embeddings**: merge the WIKI + IMDB chunk files into one final embeddings array
   + manifest (name, thumbnail filename, source) — a few hundred MB.
3. **Sanity-check the consolidated artifact** against `match.py`'s existing test queries before
   it goes anywhere near AWS — cheaper to catch a packaging bug locally than in a Lambda log.

## Milestone 2 — Kubernetes backend (SUPERSEDED plan below kept for record; current plan follows)

*(Original Lambda-targeted plan, not being built — kept only so the reasoning that led to the
container-bundling idea isn't lost. Skip to "Current plan" below.)*

<details>
<summary>Original Lambda plan (not building this)</summary>

**Decision point (resolve at the start of this milestone, once Milestone 1's exact artifact size
is known):**
- **Container image + ECR** — bundle model/embeddings/thumbnails directly in the image. Simpler,
  likely faster cold starts (no download step), but a couple cents/month in ECR storage beyond
  its free tier.
- **Plain ZIP Lambda + externally-hosted data** (Hugging Face Hub or GitHub Releases) — genuinely
  $0, downloads the data blob into `/tmp` on cold start and caches it for warm invocations. Adds
  real latency to the first cold request.
- **IaC tool: AWS SAM vs CDK** — separate decision, same checkpoint, applies either way.

1. **Port the matching logic** (`match.py`'s detect → embed → cosine-search) into a Lambda
   handler: accept a base64 photo in the request body, return top-K name/score/thumbnail JSON.
2. **Package per the decision above**.
3. **Deploy** via the chosen IaC tool rather than clicking through the console.
4. **Lambda Function URL** for direct HTTPS access.
5. **CORS** configured on the function.
6. **Test end-to-end** with `curl`/Postman before wiring up the frontend.
7. **AWS Budget alert** (~$2) as the safety net.

</details>

### Current plan: GKE + Terraform + Helm

Prerequisite (updated from the decision log §7's AWS-specific version): a **GCP account** + billing
enabled + a **GCP budget alert** (~$10-20/month), plus `gcloud` CLI, Terraform, kubectl, and Helm
installed locally, and a GitHub repo created and pushed (this project has no git history at all
yet — that's step 0, not optional).

**API contract (unchanged from the original plan — fixed so frontend work isn't blocked on this
milestone):**
```
Request:  { "image": "<base64 jpeg/png>" }
Response: { "matches": [ { "name": str, "similarity": float, "thumbnail": "<base64 jpeg>" }, ... ] }
Error:    { "error": "no_face_detected" | "low_confidence" | "invalid_image" }
```
This already matches what `scripts/local_api_server.py` implements — the port is about *where*
this logic runs, not changing the contract.

1. **Terraform: scaffold the GKE cluster** — VPC/subnet, a **zonal** GKE cluster (not regional —
   the free-tier credit only applies to zonal/Autopilot, see Technical Design §11), a node pool,
   and Workload Identity Federation for pods to assume GCP permissions. Start here even before
   the app container is finalized; the cluster and the containerized app can be developed in
   parallel once the API contract above is fixed.
2. **Containerize** the matching logic (adapt `scripts/local_api_server.py` or rewrite in
   FastAPI — TBD, see Technical Design §11) into a Docker image bundling the model, consolidated
   embeddings, manifest, and thumbnails. Push to **Artifact Registry**.
3. **Helm chart**: `Deployment` (the container from step 2), `Service`, and an `Ingress` or
   `LoadBalancer` Service for a public HTTPS endpoint. Decide Ingress controller (GKE's native
   Ingress-to-Google-Cloud-Load-Balancer is the common choice) at this step.
4. **Deploy via Helm** against the Terraform-provisioned cluster.
5. **CORS** configured so the frontend's domain can call the endpoint from the browser.
6. **Test end-to-end** with `curl`/Postman before wiring up the frontend, so frontend bugs and
   backend bugs don't get debugged simultaneously.
7. **Cost discipline**: `terraform destroy` the cluster when not actively demoing/developing
   against it — the control-plane fee itself is credit-offset (see Technical Design §11), but the
   node pool's VM cost is not, and this doesn't scale to zero on its own — see
   Technical Design §11's cost note. The budget alert from the prerequisite step is the backstop,
   not the primary control.

## Milestone 3 — Frontend

1. **Next.js app**: single upload page — file input, preview, submit, results display
   (matched name + thumbnail + similarity score, or a clear error state for "no face detected").
2. **Calls the Lambda Function URL** directly from the browser.
3. **Local dev testing** against the deployed Lambda before deploying the frontend itself.
4. **Deploy to Vercel** (PRD D7 — free, and the natural pairing for Next.js).

## Milestone 4 — Polish pass

- Error handling for the real failure modes we already know about: no face detected, low-
  confidence detection, oversized/invalid file upload.
- A visible disclaimer per PRD D2 (dataset license, non-commercial demo).
- README covering architecture, the license caveat, and — honestly — the debugging story from
  getting GPU inference working on vast.ai (the CUDA/onnxruntime-gpu package-collision saga is a
  genuinely good "here's how I debug systematically" interview anecdote, worth writing up).

## Milestone 5 — Deferred features (v1.1+)

- Real upload storage + expiry + deletion (PRD D5) — in-memory processing satisfies "don't keep
  photos" for v1; this is the fuller feature for later.
- Embedding the remaining ~148K low-confidence-filtered images isn't planned — they were
  correctly rejected by the quality filter, not left unprocessed.
