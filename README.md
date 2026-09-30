# Celebrity Doppelganger

Upload a selfie and find your three closest celebrity lookalikes out of **139,845 face photos of 36,310 celebrities**.

The app detects the face, embeds it with ArcFace, and runs a cosine search over the index. The result is shown as a match strength calibrated against how well people who *aren't* celebrities match.

```
 Browser ──► Next.js 16 (Vercel) ──/api/match proxy──►  FastAPI backend (GKE)
 resize ≤1024px                   adds X-API-Key         SCRFD detect → ArcFace 512-d
                                                         → cosine top-k (name-deduped)
                                                         → percentile calibration
                                                                 ▲
                                          init container pulls index from private GCS
 Terraform: VPC · zonal GKE (spot node pool) · Artifact Registry · GCS · Workload Identity
 Helm: Deployment · Service (NEG) · GCE Ingress + static IP · BackendConfig · HPA
```

## Results

**Data pipeline** (IMDB-WIKI):

| Stage | Faces | Notes |
|---|---|---|
| Embedded | 277,752 | Detections scoring below 0.75 dropped (threshold chosen from evidence, `scripts/test_det_score.py`) |
| Byte-duplicate cleanup | 150,720 | 45.7% of rows were identical images filed under several names (IMDb stills credited to every co-star) |
| Label-noise cleanup | **139,845** | 65 junk wiki "User:" pages, 9,815 photos inconsistent with their identity's other photos, 995 from pairs that disagreed |

**Retrieval accuracy** (`scripts/evaluate_retrieval.py`): hold out one photo each for 2,000 celebrities with 2 or more photos, search with it, and check whether the true person appears in the top-k distinct names.

| Index | Top-1 | Top-5 | Top-10 |
|---|---|---|---|
| Before label cleanup (150,720) | 87.5% | 89.2% | 89.3% |
| After label cleanup (139,845) | 98.7% | 99.9% | 100% |

The two rows bracket the true accuracy:
- **"Before" is a lower bound.** About 10% of those queries are mislabeled photos, which can't retrieve their "own" name.
- **"After" is an upper bound.** The cleanup removed photos that disagreed with their identity, which also removes hard-but-correct queries.

**Score calibration** (`scripts/build_calibration.py`):
- The best match for someone who isn't in the index scores a raw cosine of **0.31 at the median**, 0.39 at the 95th percentile.
- The earlier fixed mapping displayed these ordinary scores as "45–75% similar". The app now shows **match strength**: the percentile of your best score among 5,000 such stranger queries.
- So "80%" means your match is closer than 80% of people's.

**Latency:**
- Search: ~24 ms over 139,845 faces with brute-force numpy on CPU. At this size FAISS isn't needed.
- Embedding: ~0.55 s per image on CPU and ~0.011 s on an RTX 3060 Ti. The full dataset was embedded on a rented Vast.ai GPU (`notebooks/`).

## Run locally

Requires the data under `data/`, which isn't in the repo (see *Data* below).

```bash
pip install -r backend/requirements.txt
uvicorn backend.app:app --port 8787        # first run downloads the insightface buffalo_l model

cd frontend && npm install && npm run dev  # http://localhost:3000
```

To rebuild the index artifacts from the embeddings:

```bash
python scripts/clean_label_noise.py        # -> data/processed/consolidated_clean/
python scripts/evaluate_retrieval.py --index data/processed/consolidated_clean
cd scripts && python build_calibration.py  # -> backend/calibration.json
```

Tests (no model or dataset needed):

```bash
pip install -r backend/requirements-dev.txt && pytest backend/tests
```

## Deploy (GKE)

```bash
cd infra/terraform && cp terraform.tfvars.example terraform.tfvars   # set project_id
terraform init && terraform apply
cd ../.. && API_KEY=$(openssl rand -hex 24) ./scripts/deploy.sh
```

`deploy.sh` does four things:
1. Uploads the packaged index to the private bucket.
2. Builds and pushes the image.
3. Fetches cluster credentials.
4. Runs `helm upgrade --install`.

Then set `BACKEND_URL` and `BACKEND_API_KEY` in the Vercel project, as printed at the end of the script.

**Cost:** one zonal cluster, so the GKE free-tier credit covers the control-plane fee. Only the e2-standard-2 spot node and the load balancer are billed.

## Privacy & data

- **Uploads:** decoded and embedded in memory only. Nothing is written to disk or logged, and the embedding is discarded after the request.
- **Dataset:** [IMDB-WIKI](https://data.vision.ee.ethz.ch/cvl/rrothe/imdb-wiki/) is licensed for **academic research only**. That's why the dataset, embeddings and thumbnails are gitignored, never baked into the image, and served from a private bucket.
- **Scope:** this is a non-commercial portfolio demo.

## Repo layout

```
backend/          FastAPI matcher, calibration.json, Dockerfile, tests
frontend/         Next.js 16 + React 19 + Tailwind v4 + Framer Motion
infra/terraform/  GKE, VPC, Artifact Registry, GCS, Workload Identity
infra/helm/       backend chart
scripts/          embedding, dedup, cleaning, evaluation, calibration, packaging, deploy
notebooks/        Vast.ai GPU embedding notebook
docs/             PRD, technical design, build plan, decision log
reports/          evaluation + cleaning results (JSON)
```

## Known limitations

- 74% of identities have a single photo, which can't be cross-checked. 3,733 of them come from IMDb and may be mislabeled.
- Match strength ranks how *close* a match is, not whether a human would call it a lookalike. There's no user study.
- IMDB-WIKI skews toward Western film and TV figures, so matches are likely weaker for underrepresented groups. This hasn't been measured.
