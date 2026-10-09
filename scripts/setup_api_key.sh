#!/usr/bin/env bash
# Turns on the backend's API key for the free deployment (Modal + Vercel), without the key ever
# being printed: generates a random key, saves it as the Modal secret `doppelganger-api-key`
# (read by deploy/modal_app.py as API_KEY), and copies it to the clipboard for Vercel's
# BACKEND_API_KEY. Order matters: set it on Vercel and redeploy the frontend FIRST, then
# `modal deploy deploy/modal_app.py` - the other way round, the site would get 401s meanwhile.
set -euo pipefail
cd "$(dirname "$0")/.."
MODAL="${MODAL:-$(cd .. && pwd)/.hf-venv/bin/modal}"

KEY=$(openssl rand -hex 24)
"$MODAL" secret create doppelganger-api-key API_KEY="$KEY" --force >/dev/null
printf '%s' "$KEY" | pbcopy
echo "Saved as Modal secret doppelganger-api-key, and copied to your clipboard (not shown)."
echo "Next: Vercel -> project -> Settings -> Environment Variables -> BACKEND_API_KEY = paste -> Redeploy."
