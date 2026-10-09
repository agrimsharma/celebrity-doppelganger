# Going live for free (Modal + Vercel, no card anywhere)

**Cost: ₹0.** Modal's Starter plan gives $30/month of compute credit with no card on file; the
backend scales to zero when idle, so a visit costs a fraction of a cent. Vercel's Hobby
plan is free. If Modal's credit ever ran out, the backend would simply stop until next month.

The first request after an idle period starts a container (~15-30 s); the page shows
"Waking up the model" meanwhile.

## 1. Backend → Modal (~15 min)

1. modal.com → sign up with **GitHub** (`agrimsharma`) → stay on **Starter**.
2. Connect this Mac (opens the browser):
   ```bash
   ~/Downloads/Projects/.hf-venv/bin/modal token new
   ```
3. Upload the face index to a private Modal Volume (~1 GB) and deploy:
   ```bash
   python3 scripts/package_index.py      # already done if data/deploy/index/thumbnails.bin exists
   modal volume create doppelganger-index
   modal volume put doppelganger-index data/deploy/index /
   modal deploy deploy/modal_app.py
   ```
4. Check `https://<workspace>--doppelganger-api.modal.run/readyz` → `{"ready": true, ...}`

## 2. Frontend → Vercel (~5 min)

1. vercel.com → **Continue with GitHub** (`agrimsharma`) → Hobby plan (free).
2. **Add New → Project** → import `celebrity-doppelganger` → **Root Directory: `frontend`**.
3. Environment variables:
   - `BACKEND_URL` = `https://<workspace>--doppelganger-api.modal.run/match`
   - `BACKEND_API_KEY` = the key from `./scripts/setup_api_key.sh` (it's copied to your clipboard and
     saved on Modal; the backend then rejects any request without it). Set this and redeploy the
     frontend *before* deploying the backend with the key, or the site gets 401s in between.
4. **Deploy** → your permanent link is `https://<project>.vercel.app`.
