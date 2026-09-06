import os
import cv2
import numpy as np
import pandas as pd
import time

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "wiki_manifest.csv")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "suspected_junk.csv")

df = pd.read_csv(MANIFEST_PATH, encoding="utf-8")
print(f"Scanning {len(df)} images for near-flat (solid color) or low-color-diversity (icon/diagram) content...")

flags = []
t0 = time.time()
for i, row in df.iterrows():
    img_path = os.path.join(BASE, row["path"])
    img = cv2.imread(img_path)
    if img is None:
        continue
    std = img.std()
    # near-flat / solid color (e.g. broken-image placeholder rendered as black or gray)
    is_flat = std < 5
    # icon/diagram: very low unique-color count relative to pixel count (flat regions + thin lines)
    small = cv2.resize(img, (64, 64))
    unique_colors = len(np.unique(small.reshape(-1, 3), axis=0))
    is_icon_like = unique_colors < 40 and not is_flat
    if is_flat or is_icon_like:
        flags.append({
            "path": row["path"], "name": row["name"], "face_score": row["face_score"],
            "std": round(float(std), 2), "unique_colors_64px": unique_colors,
            "reason": "flat" if is_flat else "icon_like",
        })
    if (i + 1) % 10000 == 0:
        print(f"  {i+1}/{len(df)}, {time.time()-t0:.1f}s, {len(flags)} flagged so far")

print(f"\nDone in {time.time()-t0:.1f}s. Flagged: {len(flags)} / {len(df)} ({100*len(flags)/len(df):.2f}%)")
out = pd.DataFrame(flags)
out.to_csv(OUT_PATH, index=False, encoding="utf-8")
print(f"Written to {OUT_PATH}")
if len(flags):
    print(out["reason"].value_counts())
    print(out.head(15).to_string())
