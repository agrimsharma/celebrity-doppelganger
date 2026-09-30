#!/usr/bin/env bash
# Fetch the index from the PRIVATE dataset repo (IMDB-WIKI is academic-use only, so it's never
# public), then serve. HF_TOKEN is a read-only token stored as a Space secret.
set -euo pipefail
if [ ! -f "$INDEX_DIR/embeddings.npy" ]; then
  echo "Downloading index from ${INDEX_REPO} ..."
  python - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(os.environ["INDEX_REPO"], repo_type="dataset", local_dir=os.environ["INDEX_DIR"],
                  token=os.environ.get("HF_TOKEN"))
PY
fi
exec uvicorn backend.app:app --host 0.0.0.0 --port 7860
