import os
import sys
import time
import numpy as np
import pandas as pd
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from match import load_index, resolve_image_path

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "consolidated")
THUMB_DIR = os.path.join(OUT_DIR, "thumbnails")
THUMB_SIZE = 160

os.makedirs(THUMB_DIR, exist_ok=True)


def make_thumbnail(src_path, dst_path, size=THUMB_SIZE):
    img = cv2.imread(src_path)
    if img is None:
        return False
    h, w = img.shape[:2]
    # resize shorter side to `size`, then center-crop to size x size (avoids distortion)
    scale = size / min(h, w)
    new_w, new_h = max(size, round(w * scale)), max(size, round(h * scale))
    img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    top = (new_h - size) // 2
    left = (new_w - size) // 2
    img = img[top:top + size, left:left + size]
    cv2.imwrite(dst_path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return True


def main():
    embeddings, manifest = load_index()
    n = len(embeddings)
    print(f"Loaded {n} embeddings to consolidate")

    thumb_filenames = []
    ok_mask = np.ones(n, dtype=bool)
    t0 = time.time()

    for i in range(n):
        thumb_name = f"{i:06d}.jpg"
        thumb_filenames.append(thumb_name)
        dst_path = os.path.join(THUMB_DIR, thumb_name)
        if os.path.exists(dst_path):
            continue  # resumable - skip already-done thumbnails
        src_path = resolve_image_path(manifest.iloc[i])
        if src_path is None or not os.path.exists(src_path):
            ok_mask[i] = False
            continue
        if not make_thumbnail(src_path, dst_path):
            ok_mask[i] = False

        if (i + 1) % 5000 == 0:
            elapsed = time.time() - t0
            print(f"  {i+1}/{n} processed, {elapsed:.1f}s elapsed, {elapsed/(i+1):.4f}s/img")

    manifest = manifest.copy()
    manifest["thumbnail"] = thumb_filenames

    dropped = (~ok_mask).sum()
    if dropped:
        print(f"Dropping {dropped} rows with missing/unreadable source images")
    embeddings = embeddings[ok_mask]
    manifest = manifest[ok_mask].reset_index(drop=True)

    np.save(os.path.join(OUT_DIR, "embeddings.npy"), embeddings.astype(np.float16))
    manifest.to_csv(os.path.join(OUT_DIR, "manifest.csv"), index=False, encoding="utf-8")

    print(f"\nDone. {len(manifest)} entries consolidated.")
    print(f"Embeddings: {os.path.getsize(os.path.join(OUT_DIR, 'embeddings.npy')) / 1e6:.1f} MB")

    thumb_total_bytes = sum(
        os.path.getsize(os.path.join(THUMB_DIR, f)) for f in os.listdir(THUMB_DIR)
    )
    print(f"Thumbnails: {thumb_total_bytes / 1e6:.1f} MB across {len(os.listdir(THUMB_DIR))} files")


if __name__ == "__main__":
    main()
