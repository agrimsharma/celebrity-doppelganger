"""
Remove mislabeled faces from the consolidated index.

IMDB-WIKI's IMDb half is noisy: crops come from multi-person stills, so a photo filed under
one actor often shows a co-star (e.g. "Bitsie Tulloch" photos that are actually David Giuntoli).
clean_duplicates.py only removed byte-identical images shared across names; this handles the
rest using the embeddings themselves.

Rules:
  * junk names: Wikipedia user/sandbox/draft pages that slipped through as "celebrities"
  * >= 3 photos: drop a photo if its similarity to the leave-one-out centroid of that
    identity's other photos is < CENTROID_THRESHOLD. The score distribution is clearly bimodal
    (same person ~0.6-0.9, wrong person ~0.0-0.2), so 0.3 sits in the gap. Two passes, so
    centroids are recomputed once the worst outliers are gone.
  * exactly 2 photos that disagree (< PAIR_THRESHOLD): one of them is wrong and there's no
    majority to tell which. Keep the Wikipedia one if exactly one is from Wikipedia (single-
    person profile photos, far more reliable than IMDb stills), else drop both.
  * 1 photo: can't be verified; kept.

Writes data/processed/consolidated_clean/{embeddings.npy, manifest.csv, cleaning_report.json}.
Thumbnail filenames are unchanged and still resolve against consolidated/thumbnails/.
"""
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "processed", "consolidated")
DST = os.path.join(HERE, "..", "data", "processed", "consolidated_clean")
CENTROID_THRESHOLD = 0.3
PAIR_THRESHOLD = 0.2
JUNK_NAME_PATTERN = r"^(?:User|Wikipedia|Draft|Talk|User talk):|/sandbox"


def loo_centroid_similarity(emb, codes):
    sums = np.zeros((codes.max() + 1, emb.shape[1]), dtype=np.float64)
    np.add.at(sums, codes, emb)
    loo = sums[codes] - emb
    loo /= np.linalg.norm(loo, axis=1, keepdims=True) + 1e-12
    return (loo * emb).sum(axis=1)


def main():
    emb = np.load(os.path.join(SRC, "embeddings.npy")).astype(np.float32)
    manifest = pd.read_csv(os.path.join(SRC, "manifest.csv"), encoding="utf-8")
    names = manifest["name"].astype(str)
    keep = np.ones(len(manifest), dtype=bool)
    report = {"input_rows": int(len(manifest)), "input_identities": int(names.nunique())}

    junk = names.str.contains(JUNK_NAME_PATTERN, regex=True).values
    keep &= ~junk
    report["dropped_junk_names"] = int(junk.sum())

    dropped_outliers = 0
    for _ in range(2):
        idx = np.flatnonzero(keep)
        codes = pd.factorize(names.values[idx])[0]
        counts = np.bincount(codes)[codes]
        sims = loo_centroid_similarity(emb[idx].astype(np.float64), codes)
        outlier = (counts >= 3) & (sims < CENTROID_THRESHOLD)
        keep[idx[outlier]] = False
        dropped_outliers += int(outlier.sum())
    report["dropped_centroid_outliers"] = dropped_outliers

    # identities left with exactly 2 photos
    idx = np.flatnonzero(keep)
    kept_names = pd.Series(names.values[idx], index=idx)
    pairs = kept_names.groupby(kept_names).filter(lambda s: len(s) == 2)
    dropped_pairs = 0
    for _, rows in pairs.groupby(pairs):
        a, b = rows.index
        if float(emb[a] @ emb[b]) >= PAIR_THRESHOLD:
            continue
        sources = manifest.loc[[a, b], "source"].values
        if (sources == "wiki").sum() == 1:
            drop = a if sources[0] != "wiki" else b
            keep[drop] = False
            dropped_pairs += 1
        else:
            keep[[a, b]] = False
            dropped_pairs += 2
    report["dropped_disagreeing_pairs"] = dropped_pairs

    clean = manifest[keep].reset_index(drop=True)
    counts = clean["name"].value_counts()
    report.update({
        "output_rows": int(keep.sum()),
        "output_identities": int(clean["name"].nunique()),
        "identities_with_1_photo": int((counts == 1).sum()),
        "identities_with_2plus_photos": int((counts >= 2).sum()),
        "unverified_imdb_singletons": int(((clean["source"] == "imdb") & clean["name"].map(counts).eq(1)).sum()),
        "centroid_threshold": CENTROID_THRESHOLD,
        "pair_threshold": PAIR_THRESHOLD,
    })

    os.makedirs(DST, exist_ok=True)
    np.save(os.path.join(DST, "embeddings.npy"), emb[keep].astype(np.float16))
    clean.to_csv(os.path.join(DST, "manifest.csv"), index=False, encoding="utf-8")
    with open(os.path.join(DST, "cleaning_report.json"), "w") as f:
        json.dump(report, f, indent=2)
    for k, v in report.items():
        print(f"{k}: {v:,}" if isinstance(v, int) else f"{k}: {v}")


if __name__ == "__main__":
    main()
