# PRD: Celebrity Doppelganger Finder

**Status:** Draft v1
**Author:** Agrim Sharma
**Last updated:** 2026-08-20

---

## 1. Problem / Motivation

Portfolio project to demonstrate three skills together in one coherent system:

1. Applied ML — face embeddings + nearest-neighbor search at 500k+ item scale.
2. Frontend engineering (Node.js-based) — an upload UI and API, not just a notebook.
3. Cloud deployment (AWS) — a real, live, deployed system rather than a local script.

Secondary goal: the project itself should read well in interviews — clear scoping, documented
tradeoffs, and a design that shows senior-level judgment (not just "it works").

## 2. Goals

- G1: User uploads a selfie and receives the single best-matching celebrity from the IMDB-WIKI
  dataset, with a similarity score.
- G2: The system is live at a public URL, fully working end to end (upload → result), not a
  local-only demo.
- G3: Hosting cost is $0 on an ongoing basis (see Constraints — this shapes architecture choices
  more than anything else).
- G4: Uploaded user photos are not retained beyond a short expiry window.
- G5: The build produces artifacts (this PRD, a technical design doc, architecture diagram) that
  are themselves presentable in an interview.

## 3. Non-Goals (v1)

- Top-N ranked results *in the UI* (v1 shows one match only; see D4 — the API itself returns
  ranked top-K so showing top-3/5 later is a UI-only change).
- Training or fine-tuning a face embedding model — use a pretrained model (e.g. via `insightface`,
  already validated locally).
- Supporting video, multiple faces per image, or batch uploads.
- Handling adversarial inputs robustly (no face, non-human image) beyond a basic "no face detected"
  error.
- Guaranteed uptime / SLA — this is a portfolio demo, brief downtime is acceptable.

## 4. Target User

Primarily: interviewers/recruiters trying the live link, and Agrim demoing it in interviews.
Secondarily: casual users who find the link and want to try it once.

## 5. Constraints

- **Budget: $0 ongoing.** Any component must fit within a free tier or be genuinely free at rest
  (scale-to-zero). This is the single biggest architectural constraint and needs to be resolved in
  the technical design doc before any AWS resource is provisioned.
- **Dataset license:** IMDB-WIKI is "for academic research purposes only" — no commercial use.
  Since this is a non-commercial portfolio demo that's a reasonable fit, but the app should not
  redistribute the raw dataset (e.g. no bulk download endpoint) and should carry a visible
  disclaimer. Matched celebrity photos may be shown in the UI (see D2).
- **Privacy:** uploaded selfies are biometric data. Store only transiently, with an explicit
  expiry/delete, and say so in the UI.
- **Dataset size actually used:** 8GB pre-cropped face set (523k images), not the 280GB raw set
  (see prior discussion — cropped set has everything needed for embeddings).

## 6. Success Metrics

- End-to-end works on a fresh device: upload → result in under ~5 seconds.
- Deployed and reachable at a public URL with $0 monthly cost under normal (low, demo-level) traffic.
- No stored user images survive past their stated expiry.
- PRD + technical design doc + architecture diagram exist and are coherent enough to walk through
  in an interview.

## 7. High-Level Scope (MVP)

1. Frontend: single-page upload form (Node.js-based — framework TBD in technical design doc),
   shows result (matched celebrity name + photo + similarity score) or an error.
2. Backend API: receives image, runs face detection + embedding, queries precomputed celebrity
   embeddings for nearest match, returns result, deletes the uploaded image per the expiry policy.
3. Offline batch job (run once, not per-request): detect + embed all faces in the 8GB cropped
   IMDB-WIKI set, store embeddings + celebrity metadata (name, source image reference) in whatever
   index the technical design doc lands on.
4. Deployment: all of the above running on AWS within the $0 constraint.

## 8. Decisions Log

- **D1 — Dataset coverage: full 523k celebrities, no curation.** Accepted the harder hosting
  problem in exchange for a defensible "matched against 500k+ faces, 20k+ celebrities" claim. This
  is now a **hard requirement** for the technical design doc, not a nice-to-have: whatever
  architecture is chosen must serve a ~523k-vector index at $0 ongoing cost. If that turns out to
  be genuinely impossible at $0 (e.g. RAM limits on every free-tier compute option), this decision
  gets revisited then — but the default is to solve the hosting problem, not shrink the dataset.
- **D2 — Displaying the matched celebrity's actual dataset photo: approved.** Non-commercial demo,
  not redistributing the dataset in bulk, disclaimer shown in the UI. Revisit only if this project
  ever moves beyond a personal portfolio demo.
- **D3 — Timeline: quality-bound, not date-bound.** No fixed deadline. The real success condition
  is "a result strong enough to put on a CV/show in interviews," not shipping by a specific date —
  so we move as fast as possible without cutting corners that would make the result look weak.
  Practically: no arbitrary time-boxing of milestones, but no gold-plating either — each milestone
  ships when it's genuinely good, then we move to the next.
- **D4 — MVP returns the single best match; API designed for top-K from the start.** UI shows 1
  result in v1, but the backend/query layer returns a ranked top-K (K configurable) so switching
  the UI to show top-3 or top-5 later is a frontend-only change, not a re-architecture.
- **D5 — Upload deletion is a real feature (not just "don't persist"), but deferred.** Confirmed
  we do want actual stored-upload + deletion behavior eventually (not just in-memory-and-forget).
  For now, the matching pipeline runs in-memory with no persistence, which is a strict subset of
  the eventual behavior — the storage+expiry+deletion subsystem gets built once the core matching
  quality is validated (see D6), not before.
- **D6 — Build order: validate matching quality first, infra second.** Before any AWS/frontend
  work, prove out the actual face-matching pipeline locally (does it return results that feel
  right?) using the existing local `insightface` setup. Only once satisfied with match quality do
  we move to Lambda/AWS, the Node.js frontend, and deployment. Batch embedding job runs locally
  first (not distributed on Lambda) to keep this phase fast — see Technical Design Doc §6.
- **D7 — Frontend hosting: a free external platform** (Vercel/GitHub Pages), not S3+CloudFront.
  Doesn't affect the Node.js skill story either way; chosen to avoid AWS free-tier ambiguity for a
  component where "AWS-native" wasn't load-bearing.

## 9. Risks

- Free-tier AWS components can have cold-start latency (e.g. Lambda) — may affect the "under 5
  seconds" success metric; needs validation once architecture is chosen.
- Free tier limits (S3, Lambda, EC2 free-tier hours) are mostly time-boxed (12 months for new
  accounts) or capacity-boxed — need an architecture that stays under those limits at realistic
  demo traffic, not just on paper.
- Dataset license is non-commercial; if this project were ever monetized or scaled beyond a demo,
  the dataset would need to be replaced.
- **Full-dataset-at-$0 (D1) is the biggest technical risk in this PRD.** A ~523k-item vector index
  won't fit comfortably on the smallest free-tier compute (e.g. 1GB-RAM instances) using a naive
  in-memory index. The technical design doc needs to find a real answer (disk-backed ANN index,
  quantized/compressed vectors, a scale-to-zero container that loads the index on demand, etc.)
  before this is provisioned — not assume it'll fit.

## 10. Out of Scope for This Document

Technology choices (which AWS services, which vector index, which Node.js framework), cost
modeling, and detailed data flow belong in the **Technical Design Doc**, written next.
