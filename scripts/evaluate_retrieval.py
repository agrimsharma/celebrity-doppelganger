"""
Quantitative evaluation of the matching index (no re-embedding needed - works on the
consolidated embeddings directly).

1. Identity retrieval (leave-one-out): for identities with >= 2 photos, hold one photo out of
   the index, search with it, and check where the true name lands among the top-k *distinct*
   names (same name-dedup as the live API). This is the closest measurable proxy for "does the
   search find the right face" - a doppelganger app has no ground truth, but a retrieval system
   that can't find the same person's other photo can't be trusted to find lookalikes either.

2. Stranger baseline (leave-identity-out): remove ALL of an identity's photos, then search with
   one of them. The top-1 score is exactly what a random member of the public (someone not in
   the index) gets. This null distribution is what the "% similar" display must be calibrated
   against - see calibration.py.

Usage: python scripts/evaluate_retrieval.py [--index DIR] [--n 2000] [--out reports/eval.json]
"""
import argparse
import json
import os
import time

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INDEX = os.path.join(HERE, "..", "data", "processed", "consolidated")
KS = (1, 5, 10)
POOL = 300  # candidates pulled per query before name-dedup; plenty for top-10 distinct names
BATCH = 256


def load_index(index_dir):
    emb = np.load(os.path.join(index_dir, "embeddings.npy")).astype(np.float32)
    manifest = pd.read_csv(os.path.join(index_dir, "manifest.csv"), encoding="utf-8")
    assert len(emb) == len(manifest)
    return emb, manifest


def distinct_names_ranked(sims_row, names, k):
    pool = np.argpartition(-sims_row, POOL)[:POOL]
    pool = pool[np.argsort(-sims_row[pool])]
    out, seen = [], set()
    for i in pool:
        n = names[i]
        if n not in seen:
            seen.add(n)
            out.append((n, float(sims_row[i])))
            if len(out) == k:
                break
    return out


def leave_one_out(emb, names, name_codes, rng, n):
    counts = np.bincount(name_codes)
    eligible = np.flatnonzero(counts[name_codes] >= 2)
    # one query per identity, so celebrities with 200+ photos don't dominate
    per_identity = pd.Series(eligible).groupby(name_codes[eligible]).apply(lambda s: rng.choice(s.values))
    queries = rng.choice(per_identity.values, size=min(n, len(per_identity)), replace=False)

    hits = {k: 0 for k in KS}
    true_top1_scores, same_person_best = [], []
    for start in range(0, len(queries), BATCH):
        q = queries[start:start + BATCH]
        sims = emb[q] @ emb.T
        sims[np.arange(len(q)), q] = -np.inf  # hold the query photo itself out
        for row, qi in zip(sims, q):
            ranked = distinct_names_ranked(row, names, max(KS))
            ranked_names = [r[0] for r in ranked]
            for k in KS:
                hits[k] += names[qi] in ranked_names[:k]
            true_top1_scores.append(ranked[0][1])
            same_person_best.append(float(row[name_codes == name_codes[qi]].max()))
    return {
        "n_queries": int(len(queries)),
        "n_eligible_identities": int(len(per_identity)),
        **{f"top{k}_accuracy": hits[k] / len(queries) for k in KS},
        "best_same_person_score_median": float(np.median(same_person_best)),
        "share_same_person_best_below_0.2": float(np.mean(np.array(same_person_best) < 0.2)),
    }


def stranger_baseline(emb, names, name_codes, rng, n):
    """Top-1 score for queries whose identity is entirely absent from the index."""
    queries = rng.choice(len(emb), size=min(n, len(emb)), replace=False)
    top1 = []
    for start in range(0, len(queries), BATCH):
        q = queries[start:start + BATCH]
        sims = emb[q] @ emb.T
        same = name_codes[q][:, None] == name_codes[None, :]
        sims[same] = -np.inf
        top1.extend(sims.max(axis=1).tolist())
    top1 = np.array(top1)
    pct = [1, 5, 10, 25, 50, 75, 90, 95, 99]
    return {
        "n_queries": int(len(queries)),
        "top1_score_percentiles": {str(p): float(np.percentile(top1, p)) for p in pct},
        "top1_scores": top1.tolist(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=os.path.join(HERE, "..", "reports", "retrieval_eval.json"))
    args = ap.parse_args()

    # numpy 2.x + macOS Accelerate emits spurious divide/overflow warnings from matmul on
    # finite, unit-norm inputs (verified against float64: max diff ~1e-6) - silence them
    np.seterr(all="ignore")
    t0 = time.time()
    emb, manifest = load_index(args.index)
    names = manifest["name"].astype(str).values
    name_codes = pd.factorize(names)[0]
    rng = np.random.default_rng(args.seed)
    print(f"Index: {len(emb):,} faces, {name_codes.max() + 1:,} identities")

    loo = leave_one_out(emb, names, name_codes, rng, args.n)
    print(f"\nLeave-one-out identity retrieval ({loo['n_queries']} identities with >= 2 photos):")
    for k in KS:
        print(f"  top-{k}: {loo[f'top{k}_accuracy']:.1%}")
    print(f"  median best same-person score: {loo['best_same_person_score_median']:.3f}")
    print(f"  identities whose closest same-name photo scores < 0.2 (likely mislabeled): "
          f"{loo['share_same_person_best_below_0.2']:.1%}")

    stranger = stranger_baseline(emb, names, name_codes, rng, args.n)
    p = stranger["top1_score_percentiles"]
    print(f"\nStranger baseline (identity removed from index, {stranger['n_queries']} queries):")
    print(f"  top-1 score p5={p['5']:.3f}  p50={p['50']:.3f}  p95={p['95']:.3f}  p99={p['99']:.3f}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    result = {"index_dir": os.path.relpath(os.path.abspath(args.index), os.path.join(HERE, "..")), "n_faces": int(len(emb)),
              "n_identities": int(name_codes.max() + 1), "leave_one_out": loo,
              "stranger_baseline": {k: v for k, v in stranger.items() if k != "top1_scores"}}
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    np.save(os.path.splitext(args.out)[0] + "_stranger_top1.npy", np.array(stranger["top1_scores"], dtype=np.float32))
    print(f"\nSaved {args.out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
