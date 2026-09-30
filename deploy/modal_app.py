"""
Free-tier backend on Modal (Starter plan: $30/month of credit, no card on file).

Serverless: a container starts on the first request, stays warm for SCALEDOWN_S seconds after the
last one, then scales to zero - an idle backend costs nothing. The face index lives on a Modal
Volume (private; IMDB-WIKI is academic-use only), the face model is baked into the image.

One-time setup (see deploy/FREE_TIER.md):
  modal volume create doppelganger-index
  modal volume put doppelganger-index data/deploy/index /
Deploy:
  modal deploy deploy/modal_app.py
-> https://<workspace>--doppelganger-api.modal.run   (Vercel: BACKEND_URL=<that>/match)
"""
import pathlib

import modal

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCALEDOWN_S = 300  # keep a container warm 5 min after the last request: a recruiter's clicks stay fast

app = modal.App("doppelganger")
index = modal.Volume.from_name("doppelganger-index", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    # libxcb1/libgl1: insightface depends on the GUI opencv-python build, which links them
    .apt_install("libglib2.0-0", "libxcb1", "libgl1", "build-essential")
    .pip_install_from_requirements(str(ROOT / "backend" / "requirements.txt"))
    # bake the face model in, so a cold start only has to load it
    .run_commands(
        "python -c \"from insightface.app import FaceAnalysis; "
        "FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], "
        "providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(320, 320))\""
    )
    .env({"INDEX_DIR": "/index", "MPLCONFIGDIR": "/tmp", "PYTHONPATH": "/root"})
    .add_local_dir(str(ROOT / "backend"), "/root/backend", ignore=["tests", "__pycache__", "Dockerfile"])
)


@app.function(
    image=image,
    volumes={"/index": index},
    cpu=1.0,
    memory=2048,
    scaledown_window=SCALEDOWN_S,
    max_containers=2,  # caps spend even under a traffic spike
    timeout=120,
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app(label="doppelganger-api")
def api():
    # FastAPI's lifespan loads the index + model once per container
    from backend.app import app as fastapi_app

    return fastapi_app
