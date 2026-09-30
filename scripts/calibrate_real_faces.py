"""
Calibrate "match strength" against photos of ordinary people - the users the app actually gets.

build_calibration.py used leave-identity-out queries from the index itself: celebrity film/press
crops. Real uploads (phone photos of non-celebrities) score lower against the index than those
in-domain queries do, so the in-domain null made typical users look like poor matches (1-33%
on the test selfies). This measures the null on FFHQ instead: Flickr portraits of ordinary
people, run through the exact production pipeline (SCRFD, same det-score cutoff, ArcFace).

Runs inside the backend image (needs insightface):
  docker run --rm -v "$PWD:/repo" -w /repo -e MPLCONFIGDIR=/tmp doppelganger-backend \
    python scripts/calibrate_real_faces.py --images data/raw/ffhq/images
"""
import argparse
import glob
import json
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from backend.app import MIN_DET_SCORE, InsightFaceEmbedder  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")
DEFAULT_INDEX = os.path.join(REPO, "data", "processed", "consolidated_clean", "embeddings.npy")
OUT = os.path.join(REPO, "backend", "calibration.json")
REPORT = os.path.join(REPO, "reports", "calibration_real_faces.json")
TEST_QUERIES = os.path.join(REPO, "data", "test_queries")


def top1(index, emb):
    with np.errstate(all="ignore"):
        return float((index @ emb).max())


def embed(embedder, img):
    face = embedder.best_face(img)
    if face is None or face[1] < MIN_DET_SCORE:
        return None
    return face[0]


def resize_max(img, max_dim):
    s = max_dim / max(img.shape[:2])
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    index = np.load(args.index).astype(np.float32)
    embedder = InsightFaceEmbedder()
    paths = sorted(glob.glob(os.path.join(args.images, "*")))
    if args.limit:
        paths = paths[:args.limit]

    t0, scores, skipped = time.time(), [], 0
    for i, p in enumerate(paths):
        img = cv2.imread(p)
        emb = None if img is None else embed(embedder, img)
        if emb is None:
            skipped += 1
            continue
        scores.append(top1(index, emb))
        if (i + 1) % 500 == 0:
            print(f"  {i + 1}/{len(paths)} ({time.time() - t0:.0f}s)")
    scores = np.array(scores)
    quantiles = np.percentile(scores, np.arange(101)).round(5).tolist()

    with open(OUT) as f:
        old = json.load(f)["quantiles"]
    new_pct = lambda raw: float(np.interp(raw, quantiles, np.linspace(0, 1, 101)))
    old_pct = lambda raw: float(np.interp(raw, old, np.linspace(0, 1, 101)))

    # the app's own test selfies, at upload resolution (the frontend downsizes to 1024px) and
    # at FFHQ-like 256px, to see how much resolution alone moves the raw score
    tests = []
    for p in sorted(glob.glob(os.path.join(TEST_QUERIES, "*.jpg"))):
        img = cv2.imread(p)
        e_full, e_256 = embed(embedder, resize_max(img, 1024)), embed(embedder, resize_max(img, 256))
        if e_full is None:
            continue
        raw = top1(index, e_full)
        tests.append({"file": os.path.basename(p), "raw_top1": round(raw, 4),
                      "raw_top1_at_256px": round(top1(index, e_256), 4) if e_256 is not None else None,
                      "old_strength": round(old_pct(raw), 3), "new_strength": round(new_pct(raw), 3)})

    with open(OUT, "w") as f:
        json.dump({
            "description": "Percentiles 0..100 of the top-1 raw cosine score that photos of ordinary "
                           "people (FFHQ, non-celebrities) get against the index, through the production "
                           "detect/embed pipeline. Displayed match strength = percentile of a user's score.",
            "source": "FFHQ-256 shard 0 (Flickr portraits), scripts/calibrate_real_faces.py",
            "index_faces": int(len(index)),
            "n_queries": int(len(scores)),
            "quantiles": quantiles,
        }, f, indent=2)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump({
            "n_images": len(paths), "n_faces_used": int(len(scores)), "n_skipped_no_confident_face": skipped,
            "real_faces_top1_percentiles": {str(q): quantiles[q] for q in (5, 25, 50, 75, 95)},
            "previous_in_domain_null_percentiles": {str(q): old[q] for q in (5, 25, 50, 75, 95)},
            "test_selfies": tests,
        }, f, indent=2)

    print(f"\n{len(scores)} faces used, {skipped} skipped ({time.time() - t0:.0f}s)")
    print(f"real-face top-1:   p5={quantiles[5]:.3f} p50={quantiles[50]:.3f} p95={quantiles[95]:.3f}")
    print(f"old in-domain null: p5={old[5]:.3f} p50={old[50]:.3f} p95={old[95]:.3f}")
    for t in tests:
        print(f"  {t['file']}: raw {t['raw_top1']} (at 256px {t['raw_top1_at_256px']}) "
              f"strength {t['old_strength']:.0%} -> {t['new_strength']:.0%}")
    print(f"Saved {OUT} and {REPORT}")


if __name__ == "__main__":
    main()
