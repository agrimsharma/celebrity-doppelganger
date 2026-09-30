"""
Package the cleaned index for deployment: embeddings + manifest + only the thumbnails the
cleaned manifest references (the consolidated thumbnails/ folder still holds all 277,752
pre-cleaning files, ~half of them orphans).

Output: data/deploy/index/{embeddings.npy, manifest.csv, thumbnails/}
Upload: gcloud storage rsync -r data/deploy/index gs://<bucket>/index   (see scripts/deploy.sh)
"""
import os
import shutil

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "data", "processed", "consolidated_clean")
THUMBS = os.path.join(HERE, "..", "data", "processed", "consolidated", "thumbnails")
DST = os.path.join(HERE, "..", "data", "deploy", "index")


def main():
    manifest = pd.read_csv(os.path.join(SRC, "manifest.csv"), encoding="utf-8")
    os.makedirs(os.path.join(DST, "thumbnails"), exist_ok=True)
    for f in ("embeddings.npy", "manifest.csv"):
        shutil.copy2(os.path.join(SRC, f), os.path.join(DST, f))

    missing = 0
    for name in manifest["thumbnail"]:
        src, dst = os.path.join(THUMBS, name), os.path.join(DST, "thumbnails", name)
        if not os.path.exists(src):
            missing += 1
        elif not os.path.exists(dst):
            shutil.copy2(src, dst)
    size = sum(e.stat().st_size for e in os.scandir(os.path.join(DST, "thumbnails")))
    print(f"Packaged {len(manifest):,} faces, thumbnails {size / 1e9:.2f} GB, missing {missing}")
    print(f"-> {os.path.abspath(DST)}")


if __name__ == "__main__":
    main()
