"""
Local dev backend for real-result frontend testing - runs the same detect->embed->search
pipeline as match.py, kept warm in memory (model + 277,752-vector index loaded once at startup).
Not the production Lambda handler, but a preview of the same logic/contract. Uses the
consolidated artifact from Milestone 1 (data/processed/consolidated/), which has thumbnail
filenames attached - match.py's load_index() reads the pre-consolidation per-source chunks and
doesn't have those, so this loads the consolidated files directly instead.
"""
import os
import sys
import json
import base64
import numpy as np
import pandas as pd
import cv2
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from insightface.app import FaceAnalysis

PORT = 8787
CONSOLIDATED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "consolidated")
THUMB_DIR = os.path.join(CONSOLIDATED_DIR, "thumbnails")
MIN_DET_SCORE = 0.75

print("Loading consolidated index...")
embeddings = np.load(os.path.join(CONSOLIDATED_DIR, "embeddings.npy")).astype(np.float32)
manifest = pd.read_csv(os.path.join(CONSOLIDATED_DIR, "manifest.csv"), encoding="utf-8")
assert len(embeddings) == len(manifest), "embeddings/manifest length mismatch"
print(f"Loaded {len(embeddings)} reference embeddings")

print("Loading face model...")
app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                    providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))
print("Ready.")


def thumbnail_data_uri(filename):
    path = os.path.join(THUMB_DIR, filename)
    with open(path, "rb") as f:
        b = f.read()
    return "data:image/jpeg;base64," + base64.b64encode(b).decode()


# Calibration: raw ArcFace cosine similarity doesn't map to an intuitive "% similar" - see
# scripts/calibration_analysis.py. Anchors derived from three measured distributions:
#   random unrelated pairs:            median 0.006, rarely exceeds 0.15
#   real documented lookalike pairs:   0.30-0.40 (median 0.32) - our actual target use case
#   same identity, different photo:    0.43-0.82 (median 0.59)
_CALIBRATION_X = [0.00, 0.15, 0.25, 0.32, 0.45, 0.60, 1.00]
_CALIBRATION_Y = [0,    20,   45,   75,   90,   97,   100]


def calibrate_similarity(raw_sim):
    return float(np.interp(raw_sim, _CALIBRATION_X, _CALIBRATION_Y)) / 100.0


def top_k_matches(query_emb, k=3, pool=50):
    sims = embeddings @ query_emb
    # pull a bigger pool than we need, then keep only the first (highest-similarity) occurrence
    # of each distinct name - without this, someone with many photos in the dataset can occupy
    # multiple/all of the top slots with different pictures of themselves
    pool_idx = np.argsort(-sims)[:pool]
    results = []
    seen_names = set()
    for idx in pool_idx:
        name = manifest.iloc[idx]["name"]
        if name in seen_names:
            continue
        seen_names.add(name)
        results.append({"name": name, "similarity": calibrate_similarity(float(sims[idx])),
                         "thumbnail": thumbnail_data_uri(manifest.iloc[idx]["thumbnail"])})
        if len(results) == k:
            break
    return results


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/match":
            self._send_json({"error": "not_found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            data_uri = body.get("image", "")
            if "," not in data_uri:
                self._send_json({"error": "invalid_image"}, 400)
                return
            b64 = data_uri.split(",", 1)[1]
            img_bytes = base64.b64decode(b64)
            img_arr = np.frombuffer(img_bytes, dtype=np.uint8)
            img = cv2.imdecode(img_arr, cv2.IMREAD_COLOR)
            if img is None:
                self._send_json({"error": "invalid_image"}, 400)
                return

            faces = app.get(img)
            if not faces:
                self._send_json({"error": "no_face_detected"})
                return
            face = max(faces, key=lambda f: f.det_score)
            if face.det_score < MIN_DET_SCORE:
                self._send_json({"error": "low_confidence"})
                return

            query_emb = face.normed_embedding.astype(np.float32)
            matches = top_k_matches(query_emb, k=3)
            self._send_json({"matches": matches})
        except Exception as e:
            print("ERROR:", repr(e))
            self._send_json({"error": "invalid_image"}, 400)

    def log_message(self, format, *args):
        print(f"[server] {self.address_string()} - {format % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Listening on http://127.0.0.1:{PORT}")
    server.serve_forever()
