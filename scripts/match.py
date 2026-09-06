import os
import sys
import glob
import numpy as np
import pandas as pd
import cv2
from insightface.app import FaceAnalysis

PROCESSED = os.path.join(os.path.dirname(__file__), "..", "data", "processed")

# each source has its own chunk folder and its own local image base dir (None if we don't have
# the raw images locally - e.g. IMDB was embedded remotely and only the embeddings came back)
SOURCES = {
    "wiki": {
        "chunks_dir": os.path.join(PROCESSED, "wiki_chunks"),
        "image_base": os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop"),
    },
    "imdb": {
        "chunks_dir": os.path.join(PROCESSED, "imdb_chunks"),
        "image_base": os.path.join(os.path.dirname(__file__), "..", "data", "raw", "imdb_crop", "imdb_crop"),
    },
}

MIN_DET_SCORE = 0.75


def load_index():
    all_embeddings = []
    all_manifests = []
    for source, cfg in SOURCES.items():
        chunk_emb_files = sorted(glob.glob(os.path.join(cfg["chunks_dir"], "chunk_*_emb.npy")))
        chunk_manifest_files = sorted(glob.glob(os.path.join(cfg["chunks_dir"], "chunk_*_manifest.csv")))
        assert len(chunk_emb_files) == len(chunk_manifest_files), f"{source}: chunk emb/manifest count mismatch"
        if not chunk_emb_files:
            continue
        embeddings = np.concatenate([np.load(f) for f in chunk_emb_files]).astype(np.float32)
        manifest = pd.concat([pd.read_csv(f, encoding="utf-8") for f in chunk_manifest_files],
                              ignore_index=True)
        assert len(embeddings) == len(manifest), f"{source}: embeddings/manifest length mismatch"
        manifest["source"] = source
        all_embeddings.append(embeddings)
        all_manifests.append(manifest)

    embeddings = np.concatenate(all_embeddings)
    manifest = pd.concat(all_manifests, ignore_index=True)
    assert len(embeddings) == len(manifest), "combined embeddings/manifest length mismatch"
    return embeddings, manifest


def resolve_image_path(row):
    """Full local path to a reference image, or None if we don't have that source's raw images locally."""
    base = SOURCES[row["source"]]["image_base"]
    if base is None:
        return None
    return os.path.join(base, row["path"])


def embed_query(app, image_path):
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")
    faces = app.get(img)
    if not faces:
        raise ValueError("No face detected in query image")
    face = max(faces, key=lambda f: f.det_score)
    if face.det_score < MIN_DET_SCORE:
        print(f"Warning: low detector confidence ({face.det_score:.3f}) on query image")
    return face.normed_embedding.astype(np.float32)


def top_k_matches(query_emb, embeddings, manifest, k=5):
    # embeddings are L2-normalized (insightface normed_embedding), so dot product == cosine similarity
    sims = embeddings @ query_emb
    top_idx = np.argsort(-sims)[:k]
    results = []
    for idx in top_idx:
        row = manifest.iloc[idx]
        results.append({"name": row["name"], "path": row["path"], "source": row["source"],
                         "similarity": float(sims[idx])})
    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python match.py <path_to_query_image> [k]")
        sys.exit(1)
    query_path = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    embeddings, manifest = load_index()
    print(f"Loaded {len(embeddings)} reference embeddings")

    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                        providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(320, 320))

    query_emb = embed_query(app, query_path)
    results = top_k_matches(query_emb, embeddings, manifest, k=k)

    print(f"\nTop {k} matches for {query_path}:")
    for r in results:
        print(f"  {r['name']:30s} similarity={r['similarity']:.4f}  [{r['source']}]  ({r['path']})")
