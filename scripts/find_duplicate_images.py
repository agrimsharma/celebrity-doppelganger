import os
import hashlib
import pandas as pd
from collections import defaultdict

CONSOLIDATED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "consolidated")
WIKI_BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
IMDB_BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "imdb_crop", "imdb_crop")

manifest = pd.read_csv(os.path.join(CONSOLIDATED_DIR, "manifest.csv"), encoding="utf-8")
print(f"Checking {len(manifest)} source images for exact-duplicate content...")

hash_to_names = defaultdict(set)
hash_to_rows = defaultdict(list)

for i, row in manifest.iterrows():
    base = WIKI_BASE if row["source"] == "wiki" else IMDB_BASE
    path = os.path.join(base, row["path"])
    try:
        with open(path, "rb") as f:
            h = hashlib.md5(f.read()).hexdigest()
    except FileNotFoundError:
        continue
    hash_to_names[h].add(row["name"])
    hash_to_rows[h].append((row["name"], row["path"], row["source"]))

    if (i + 1) % 20000 == 0:
        print(f"  {i+1}/{len(manifest)} checked")

conflicting = {h: names for h, names in hash_to_names.items() if len(names) > 1}
print(f"\nDone. {len(conflicting)} distinct images have >1 different name attached "
      f"(out of {len(hash_to_names)} unique image hashes, {len(manifest)} total rows)")

print("\n--- First 15 examples ---")
for h in list(conflicting.keys())[:15]:
    print(hash_to_rows[h])
