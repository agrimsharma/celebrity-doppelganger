"""
Package the cleaned index for deployment: embeddings + manifest + the thumbnails the cleaned
manifest references, PACKED into one file (thumbnails.bin + thumbnail_offsets.npy) - 140K loose
JPEGs are slow to upload to a Hugging Face dataset and to sync in a Kubernetes init container.

Output: data/deploy/index/{embeddings.npy, manifest.csv, thumbnails.bin, thumbnail_offsets.npy}
Upload: scripts/publish_hf.py (Hugging Face) or scripts/deploy.sh (GCS)
"""
import os
import shutil
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from backend.matcher import PACK_BIN, PACK_OFFSETS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "processed", "consolidated_clean")
THUMBS = os.path.join(HERE, "..", "data", "processed", "consolidated", "thumbnails")
DST = os.path.join(HERE, "..", "data", "deploy", "index")


def main():
    manifest = pd.read_csv(os.path.join(SRC, "manifest.csv"), encoding="utf-8")
    os.makedirs(DST, exist_ok=True)
    for f in ("embeddings.npy", "manifest.csv"):
        shutil.copy2(os.path.join(SRC, f), os.path.join(DST, f))
    loose = os.path.join(DST, "thumbnails")  # older unpacked layout
    if os.path.isdir(loose):
        shutil.rmtree(loose)

    offsets = np.zeros((len(manifest), 2), dtype=np.int64)
    missing, pos = 0, 0
    with open(os.path.join(DST, PACK_BIN), "wb") as out:
        for i, name in enumerate(manifest["thumbnail"]):
            path = os.path.join(THUMBS, name)
            if not os.path.exists(path):
                missing += 1
                continue
            with open(path, "rb") as f:
                data = f.read()
            out.write(data)
            offsets[i] = (pos, len(data))
            pos += len(data)
    np.save(os.path.join(DST, PACK_OFFSETS), offsets)
    print(f"Packed {len(manifest):,} faces, thumbnails {pos / 1e9:.2f} GB, missing {missing}")
    print(f"-> {os.path.abspath(DST)}")


if __name__ == "__main__":
    main()
