import os
import re
import hashlib
import numpy as np
import pandas as pd
from collections import defaultdict

CONSOLIDATED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "consolidated")
WIKI_BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
IMDB_BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "imdb_crop", "imdb_crop")

NAMESPACE_RE = re.compile(
    r"^(User|User talk|Wikipedia|Talk|Template|Category|File|Draft|Portal|Help|MediaWiki|Special)\s*:",
    re.IGNORECASE,
)


def is_junk_name(name):
    if not isinstance(name, str):
        return True
    if NAMESPACE_RE.match(name):
        return True
    if "/sandbox" in name.lower():
        return True
    return False


manifest = pd.read_csv(os.path.join(CONSOLIDATED_DIR, "manifest.csv"), encoding="utf-8")
embeddings = np.load(os.path.join(CONSOLIDATED_DIR, "embeddings.npy"))
print(f"Loaded {len(manifest)} rows")

junk_mask = manifest["name"].apply(is_junk_name)
print(f"Namespace-junk names (User:/Talk:/sandbox/etc.): {junk_mask.sum()}")

print("\nHashing source images (this takes a few minutes)...")
hash_to_indices = defaultdict(list)
for i, row in manifest.iterrows():
    base = WIKI_BASE if row["source"] == "wiki" else IMDB_BASE
    path = os.path.join(base, row["path"])
    try:
        with open(path, "rb") as f:
            h = hashlib.md5(f.read()).hexdigest()
    except FileNotFoundError:
        h = f"missing_{i}"
    hash_to_indices[h].append(i)
    if (i + 1) % 40000 == 0:
        print(f"  {i+1}/{len(manifest)} hashed")

print(f"\n{len(hash_to_indices)} unique images among {len(manifest)} rows")

keep_mask = np.ones(len(manifest), dtype=bool)
dropped_junk_only = 0
dropped_ambiguous_images = 0
resolved_by_junk_removal = 0

for h, idxs in hash_to_indices.items():
    if len(idxs) == 1:
        continue
    names = [manifest.iloc[i]["name"] for i in idxs]
    junk_flags = [is_junk_name(n) for n in names]
    real_names = {n for n, j in zip(names, junk_flags) if not j}

    if len(real_names) == 0:
        # every name attached to this image is junk - drop the lot
        for i in idxs:
            keep_mask[i] = False
        dropped_junk_only += len(idxs)
    elif len(real_names) == 1:
        # exactly one real identity - drop the junk rows, keep the real one(s)
        for i, j in zip(idxs, junk_flags):
            if j:
                keep_mask[i] = False
        resolved_by_junk_removal += 1
    else:
        # genuinely ambiguous: 2+ different real people attached to the identical image -
        # we can't safely tell which name the face actually belongs to, so drop all of them
        for i in idxs:
            keep_mask[i] = False
        dropped_ambiguous_images += len(idxs)

print(f"\nGroups resolved by removing junk names only (kept the real identity): {resolved_by_junk_removal}")
print(f"Rows dropped - image had only junk names attached: {dropped_junk_only}")
print(f"Rows dropped - genuinely ambiguous (2+ real people, same image): {dropped_ambiguous_images}")
print(f"Total rows dropped: {(~keep_mask).sum()} / {len(manifest)}")

cleaned_manifest = manifest[keep_mask].reset_index(drop=True)
cleaned_embeddings = embeddings[keep_mask]

cleaned_manifest.to_csv(os.path.join(CONSOLIDATED_DIR, "manifest_cleaned.csv"), index=False, encoding="utf-8")
np.save(os.path.join(CONSOLIDATED_DIR, "embeddings_cleaned.npy"), cleaned_embeddings)
print(f"\nWrote cleaned set: {len(cleaned_manifest)} rows "
      f"(was {len(manifest)}, dropped {len(manifest) - len(cleaned_manifest)})")
