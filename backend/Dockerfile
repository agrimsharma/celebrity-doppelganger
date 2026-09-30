# Build from the repo root:  docker build -f backend/Dockerfile -t doppelganger-backend .
#
# The face model weights are baked in (so pods start without an internet download);
# the celebrity index is NOT - IMDB-WIKI is academic-use-only and shouldn't be
# redistributed in an image. Mount it at /index (local) or let the Helm chart's init
# container pull it from a private GCS bucket.

FROM python:3.11-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

FROM python:3.11-slim
# libxcb1/libgl1: insightface depends on the GUI opencv-python build, which links them
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libxcb1 libgl1 && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels

USER app
WORKDIR /home/app
# insightface caches models under ~/.insightface
RUN python -c "from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(320, 320))"

COPY --chown=app backend/ backend/
ENV INDEX_DIR=/index THUMB_DIR=/index/thumbnails PYTHONUNBUFFERED=1
EXPOSE 8787
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "1"]
