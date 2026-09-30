"""
In-domain stranger baseline: the distribution of top-1 match scores for leave-identity-out
queries from the index itself (celebrity crops). Kept as an analysis; the SERVED calibration
(backend/calibration.json) comes from scripts/calibrate_real_faces.py, because real uploads of
ordinary people score lower than these in-domain queries.

Why: the old calibration (local_api_server.py) mapped raw cosine scores through anchors from
10 hand-picked lookalike pairs, so ordinary chance-level best matches (~0.30 over ~140K faces)
displayed as "45-75% similar". Against this null distribution, a displayed score of 80% means
"a closer best match than 80% of people get" - which is what users actually want to know.

Usage: python scripts/build_calibration.py [--index DIR] [--n 5000]
"""
import argparse
import json
import os

import numpy as np
import pandas as pd

from evaluate_retrieval import HERE, load_index, stranger_baseline

DEFAULT_INDEX = os.path.join(HERE, "..", "data", "processed", "consolidated_clean")
OUT = os.path.join(HERE, "..", "reports", "calibration_in_domain.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--n", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    np.seterr(all="ignore")  # spurious Accelerate matmul warnings, see evaluate_retrieval.py

    emb, manifest = load_index(args.index)
    codes = pd.factorize(manifest["name"].astype(str).values)[0]
    null = np.array(stranger_baseline(emb, manifest["name"].values, codes,
                                      np.random.default_rng(args.seed), args.n)["top1_scores"])

    quantiles = np.percentile(null, np.arange(101)).round(5).tolist()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({
            "description": "Percentiles 0..100 of the top-1 raw cosine score for queries whose "
                           "identity is absent from the index (leave-identity-out).",
            "index_faces": int(len(emb)),
            "n_queries": int(len(null)),
            "quantiles": quantiles,
        }, f, indent=2)
    print(f"null top-1: p5={quantiles[5]:.3f} p50={quantiles[50]:.3f} p95={quantiles[95]:.3f}")
    print(f"Saved {OUT}")


if __name__ == "__main__":
    main()
