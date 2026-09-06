import os
import cv2
import pandas as pd
import time

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "wiki_manifest.csv")

df = pd.read_csv(MANIFEST_PATH, encoding="utf-8")
print(f"Checking {len(df)} usable-per-metadata images for readability...")

bad = []
t0 = time.time()
for i, row in df.iterrows():
    img_path = os.path.join(BASE, row["path"])
    if not os.path.exists(img_path):
        bad.append((row["path"], "missing"))
        continue
    size = os.path.getsize(img_path)
    if size == 0:
        bad.append((row["path"], "zero-byte"))
        continue
    img = cv2.imread(img_path)
    if img is None:
        bad.append((row["path"], "unreadable"))
        continue
    if img.size == 0 or min(img.shape[0], img.shape[1]) < 10:
        bad.append((row["path"], "degenerate-shape"))

    if (i + 1) % 5000 == 0:
        print(f"  checked {i+1}/{len(df)}, {time.time()-t0:.1f}s elapsed, {len(bad)} bad so far")

print(f"\nDone in {time.time()-t0:.1f}s. Bad images: {len(bad)} / {len(df)} ({100*len(bad)/len(df):.2f}%)")
if bad:
    reasons = pd.Series([b[1] for b in bad]).value_counts()
    print(reasons)
    print("\nFirst 10 bad paths:")
    for p, r in bad[:10]:
        print(f"  {p} ({r})")
    out_path = os.path.join(os.path.dirname(MANIFEST_PATH), "bad_images.csv")
    pd.DataFrame(bad, columns=["path", "reason"]).to_csv(out_path, index=False)
    print(f"\nFull list written to {out_path}")
