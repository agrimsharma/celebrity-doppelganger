import os
import sys
import glob
import time
import multiprocessing as mp
import numpy as np
import pandas as pd
import cv2

MIN_DET_SCORE = 0.75  # below the observed 0.757-0.873 range for real photos; filters icon/diagram false positives
SAVE_EVERY = 200  # per-worker chunk size


def get_done_paths(chunks_dir):
    chunk_manifests = sorted(glob.glob(os.path.join(chunks_dir, "chunk_*_manifest.csv")))
    done = set()
    for cm in chunk_manifests:
        done.update(pd.read_csv(cm, encoding="utf-8")["path"])
    return done, len(chunk_manifests)


def worker_run(worker_id, rows, base_dir, chunks_dir, progress_queue):
    import onnxruntime as ort
    from insightface.app import FaceAnalysis  # imported inside the worker: each process needs its own model load

    # cap each worker's own ONNX session to 1 thread - parallelism now comes from separate
    # processes, not from letting every process's session fan out across all cores (that caused
    # 6 processes x 8 threads each to massively oversubscribe an 8-core machine)
    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = 1
    sess_options.inter_op_num_threads = 1
    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                        providers=["CPUExecutionProvider"], sess_options=sess_options)
    app.prepare(ctx_id=0, det_size=(320, 320))

    batch_emb, batch_rows = [], []
    seq = 0
    skip_reasons = {"unreadable": 0, "no_face": 0, "low_confidence": 0}
    kept = 0
    t0 = time.time()

    def flush():
        nonlocal batch_emb, batch_rows, seq
        if not batch_emb:
            return
        emb_array = np.stack(batch_emb).astype(np.float16)
        out_df = pd.DataFrame(batch_rows)
        np.save(os.path.join(chunks_dir, f"chunk_w{worker_id:02d}_{seq:05d}_emb.npy"), emb_array)
        out_df.to_csv(os.path.join(chunks_dir, f"chunk_w{worker_id:02d}_{seq:05d}_manifest.csv"),
                      index=False, encoding="utf-8")
        seq += 1
        batch_emb, batch_rows = [], []

    for i, row in rows.iterrows():
        img_path = os.path.join(base_dir, row["path"])
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
        batch_emb.append(face.normed_embedding)
        batch_rows.append(row)
        kept += 1
        if len(batch_emb) >= SAVE_EVERY:
            flush()
            progress_queue.put(("progress", worker_id, kept, len(rows), time.time() - t0))

    flush()
    progress_queue.put(("done", worker_id, kept, skip_reasons, time.time() - t0))


def main():
    if len(sys.argv) < 4:
        print("Usage: python embed_dataset_parallel.py <manifest_csv> <image_base_dir> <chunks_dir> [limit] [num_workers]")
        sys.exit(1)

    manifest_path = sys.argv[1]
    base_dir = sys.argv[2]
    chunks_dir = sys.argv[3]
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9
    num_workers = int(sys.argv[5]) if len(sys.argv) > 5 else max(1, os.cpu_count() - 2)

    os.makedirs(chunks_dir, exist_ok=True)

    df = pd.read_csv(manifest_path, encoding="utf-8")
    df = df.sort_values("face_score", ascending=False).head(limit).reset_index(drop=True)

    done_paths, n_chunks = get_done_paths(chunks_dir)
    remaining = df[~df["path"].isin(done_paths)].reset_index(drop=True)
    print(f"Target {len(df)}, already done {len(done_paths)} across {n_chunks} chunks, "
          f"remaining {len(remaining)}, workers={num_workers}")

    if len(remaining) == 0:
        print("Nothing left to do.")
        return

    boundaries = np.linspace(0, len(remaining), num_workers + 1, dtype=int)
    shards = [remaining.iloc[boundaries[w]:boundaries[w + 1]] for w in range(num_workers)]
    shards = [s for s in shards if len(s) > 0]
    q = mp.Queue()
    procs = []
    for w, shard in enumerate(shards):
        p = mp.Process(target=worker_run, args=(w, shard.reset_index(drop=True), base_dir, chunks_dir, q))
        p.start()
        procs.append(p)

    finished = 0
    t0 = time.time()
    while finished < len(procs):
        msg = q.get()
        if msg[0] == "done":
            _, worker_id, kept, skip_reasons, elapsed = msg
            finished += 1
            print(f"Worker {worker_id} DONE: kept={kept}, skipped={skip_reasons}, "
                  f"{elapsed:.1f}s ({finished}/{len(procs)} workers finished)")
        else:
            _, worker_id, kept, shard_len, elapsed = msg
            print(f"Worker {worker_id}: {kept}/{shard_len} kept so far, {elapsed:.1f}s elapsed, "
                  f"total wall time {time.time()-t0:.1f}s")

    for p in procs:
        p.join()
    print("All workers finished.")


if __name__ == "__main__":
    main()
