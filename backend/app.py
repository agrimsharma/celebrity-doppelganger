"""
Matching backend: detect -> embed (ArcFace) -> search -> calibrate. Replaces the stdlib
dev server (scripts/local_api_server.py) with the same request/response contract, plus the
things a deployed service needs: health/readiness probes, an upload size limit, env-driven
paths, and distinct error codes.

Privacy: uploads are decoded and embedded in memory only - nothing is written to disk or
logged, and the embedding is discarded after the request.

Run:  uvicorn backend.app:app --port 8787
"""
import base64
import binascii
import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from prometheus_client import Counter, Histogram, make_asgi_app

from backend.matcher import DEFAULT_CALIBRATION, Calibration, Index

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..")
INDEX_DIR = os.environ.get("INDEX_DIR", os.path.join(REPO, "data", "processed", "consolidated_clean"))
THUMB_DIR = os.environ.get("THUMB_DIR", os.path.join(REPO, "data", "processed", "consolidated", "thumbnails"))
CALIBRATION_PATH = os.environ.get("CALIBRATION_PATH", DEFAULT_CALIBRATION)
MIN_DET_SCORE = float(os.environ.get("MIN_DET_SCORE", "0.75"))
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
# shared secret between the Next.js proxy and this service; unset = no auth (local dev)
API_KEY = os.environ.get("API_KEY")
# "enforce" rejects requests without the key; "report" only logs and counts them - turn the key on
# in report mode first, check that real traffic carries it, then enforce (no outage if a client
# was misconfigured)
API_KEY_MODE = os.environ.get("API_KEY_MODE", "enforce")
TOP_K = 3

log = logging.getLogger("doppelganger")

# Prometheus metrics (scraped at /metrics by the ServiceMonitor in the Helm chart)
MATCH_SECONDS = Histogram("doppelganger_match_seconds", "End-to-end /match latency (decode, detect, embed, search)",
                          buckets=(0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10))
MATCH_OUTCOMES = Counter("doppelganger_match_total", "/match requests by outcome", ["outcome"])
KEY_CHECKS = Counter("doppelganger_api_key_checks_total", "API key checks on /match", ["result"])
for _r in ("valid", "invalid"):
    KEY_CHECKS.labels(_r)
TOP_STRENGTH = Histogram("doppelganger_top_match_strength", "Calibrated match strength of the best match",
                         buckets=[i / 10 for i in range(1, 11)])
state = {"index": None, "embedder": None}


class InsightFaceEmbedder:
    """SCRFD detection + ArcFace w600k_r50 (insightface buffalo_l), CPU."""

    def __init__(self):
        from insightface.app import FaceAnalysis

        self.app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                                providers=["CPUExecutionProvider"])
        self.app.prepare(ctx_id=0, det_size=(320, 320))

    def best_face(self, img):
        """(normed embedding, detection score) of the most confident face, or None."""
        faces = self.app.get(img)
        if not faces:
            return None
        face = max(faces, key=lambda f: f.det_score)
        return face.normed_embedding.astype(np.float32), float(face.det_score)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if state["index"] is None:
        state["index"] = Index.load(INDEX_DIR, THUMB_DIR, Calibration.load(CALIBRATION_PATH))
        log.warning("loaded index: %d faces from %s", len(state["index"]), INDEX_DIR)
    if state["embedder"] is None:
        state["embedder"] = InsightFaceEmbedder()
    yield


app = FastAPI(title="Celebrity Doppelganger API", version="1.0.0", lifespan=lifespan)
app.mount("/metrics", make_asgi_app())


def error(code: str, status: int = 200):
    # 200 for "your photo didn't work" outcomes keeps the existing frontend contract;
    # real client/server faults get 4xx/5xx
    return JSONResponse({"error": code}, status_code=status)


def decode_image(data_uri: str):
    import cv2

    if not isinstance(data_uri, str) or "," not in data_uri:
        return None
    try:
        raw = base64.b64decode(data_uri.split(",", 1)[1], validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(raw) > MAX_IMAGE_BYTES:
        raise OverflowError
    return cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)


def match_image(data_uri: str):
    try:
        img = decode_image(data_uri)
    except OverflowError:
        return error("image_too_large", 413)
    if img is None:
        return error("invalid_image", 400)

    face = state["embedder"].best_face(img)
    if face is None:
        return error("no_face_detected")
    embedding, det_score = face
    if det_score < MIN_DET_SCORE:
        return error("low_confidence")
    return {"matches": state["index"].top_k(embedding, k=TOP_K)}


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/readyz")
def readyz():
    ready = state["index"] is not None and state["embedder"] is not None
    body = {"ready": ready, "index_faces": len(state["index"]) if state["index"] else 0}
    return JSONResponse(body, status_code=200 if ready else 503)


@app.post("/match")
async def match(request: Request):
    if API_KEY:
        # constant-time comparison, so response timing doesn't leak how much of a guess was right
        valid = hmac.compare_digest(request.headers.get("x-api-key", ""), API_KEY)
        KEY_CHECKS.labels("valid" if valid else "invalid").inc()
        if not valid:
            if API_KEY_MODE == "enforce":
                return error("unauthorized", 401)
            log.warning("request without a valid API key (report mode: allowed)")
    # base64 inflates by 4/3; reject oversized bodies before reading them into memory
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_IMAGE_BYTES * 4 // 3 + 1024:
        return error("image_too_large", 413)
    try:
        body = await request.json()
    except ValueError:
        return error("invalid_image", 400)

    t0 = time.perf_counter()
    try:
        result = await run_in_threadpool(match_image, body.get("image") if isinstance(body, dict) else None)
    except Exception:
        log.exception("match failed")  # logs the traceback, never the image
        MATCH_OUTCOMES.labels("server_error").inc()
        return error("server_error", 500)
    elapsed = time.perf_counter() - t0
    MATCH_SECONDS.observe(elapsed)
    if isinstance(result, dict):
        MATCH_OUTCOMES.labels("ok").inc()
        if result["matches"]:
            TOP_STRENGTH.observe(result["matches"][0]["similarity"])
    else:
        MATCH_OUTCOMES.labels(json.loads(result.body)["error"]).inc()
    log.info("match took %.0f ms", elapsed * 1000)
    return result
