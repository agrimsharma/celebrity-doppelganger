# Hugging Face Space (Docker SDK, free CPU tier) for the matching backend.
# scripts/publish_hf.py stages this folder + backend/ and pushes it to the Space repo.
# HF runs containers as uid 1000 and routes traffic to port 7860.

FROM python:3.11-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

FROM python:3.11-slim
# libxcb1/libgl1: insightface depends on the GUI opencv-python build, which links them
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libxcb1 libgl1 \
    && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 1000 user
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels

USER user
ENV HOME=/home/user PYTHONUNBUFFERED=1 MPLCONFIGDIR=/tmp INDEX_DIR=/home/user/index
WORKDIR /home/user/app
# bake the face model in, so a cold start only has to fetch the index
RUN python -c "from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(320, 320))"

COPY --chown=user backend/ backend/
COPY --chown=user start.sh .
EXPOSE 7860
CMD ["bash", "start.sh"]
