import os
import sys
import glob
import time
import numpy as np
import pandas as pd
import cv2
from insightface.app import FaceAnalysis

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "wiki_manifest.csv")
CHUNKS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "wiki_chunks")

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
MIN_DET_SCORE = 0.75  # below the observed 0.757-0.873 range for real photos; filters icon/diagram false positives
SAVE_EVERY = 300  # chunk size - each checkpoint writes only this many new rows, not the whole accumulated set

os.makedirs(CHUNKS_DIR, exist_ok=True)

df = pd.read_csv(MANIFEST_PATH, encoding="utf-8")
df = df.sort_values("face_score", ascending=False).head(LIMIT).reset_index(drop=True)
print(f"Target set: {len(df)} images (top by face_score)")

# resume support: each chunk is an independent small file pair, so checking what's done
# only costs reading small per-chunk manifests, not rebuilding one ever-growing file.
existing_chunk_manifests = sorted(glob.glob(os.path.join(CHUNKS_DIR, "chunk_*_manifest.csv")))
done_paths = set()
for cm in existing_chunk_manifests:
    done_paths.update(pd.read_csv(cm, encoding="utf-8")["path"])
next_chunk_idx = len(existing_chunk_manifests)

df = df[~df["path"].isin(done_paths)].reset_index(drop=True)
print(f"Resuming: {len(done_paths)} already embedded across {len(existing_chunk_manifests)} chunks, "
      f"{len(df)} remaining to process")

if len(df) == 0:
    print("Nothing left to do.")
    sys.exit(0)

app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                    providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))

skip_reasons = {"unreadable": 0, "no_face": 0, "low_confidence": 0}
t0 = time.time()

batch_embeddings = []
batch_rows = []


def flush_batch():
    global batch_embeddings, batch_rows, next_chunk_idx
    if not batch_embeddings:
        return
    emb_array = np.stack(batch_embeddings).astype(np.float16)
    out_df = pd.DataFrame(batch_rows)
    np.save(os.path.join(CHUNKS_DIR, f"chunk_{next_chunk_idx:05d}_emb.npy"), emb_array)
    out_df.to_csv(os.path.join(CHUNKS_DIR, f"chunk_{next_chunk_idx:05d}_manifest.csv"),
                  index=False, encoding="utf-8")
    next_chunk_idx += 1
    batch_embeddings = []
    batch_rows = []


total_kept = len(done_paths)
for i, row in df.iterrows():
    img_path = os.path.join(BASE, row["path"])
    img = cv2.imread(img_path)
    if img is None:
        skip_reasons["unreadable"] += 1
        continue
    faces = app.get(img)
    if not faces:
        skip_reasons["no_face"] += 1
        continue
    face = max(faces, key=lambda f: f.det_score)
    if face.det_score < MIN_DET_SCORE:
        skip_reasons["low_confidence"] += 1
        continue
    batch_embeddings.append(face.normed_embedding)
    batch_rows.append(row)
    total_kept += 1

    if len(batch_embeddings) >= SAVE_EVERY:
        flush_batch()
        elapsed = time.time() - t0
        processed = i + 1
        print(f"  {processed}/{len(df)} processed this run, {elapsed:.1f}s elapsed, "
              f"{elapsed/processed:.3f}s/img, chunk saved ({total_kept} total embedded)")

flush_batch()
elapsed = time.time() - t0
print(f"\nDone. {total_kept} total embedded, this run skipped: {skip_reasons}, "
      f"{elapsed:.1f}s total this run")
print(f"Chunks in {CHUNKS_DIR}: {next_chunk_idx}")
