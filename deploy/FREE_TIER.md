# Going live for free (Hugging Face + Vercel, no card anywhere)

**Cost: ₹0, permanently.** Neither service has a card on file, so nothing can ever be charged.
The backend sleeps after ~48 h without visitors; the page wakes it and shows a "waking up" status.

## 1. Backend → Hugging Face Space (~15 min)

1. Create a free account at huggingface.co.
2. Settings → Access Tokens → **New token**, type **Write** → then, on this Mac:
   ```bash
   python3 -m pip install --user -U huggingface_hub
   hf auth login          # paste the WRITE token into its prompt (older versions: huggingface-cli login)
   ```
3. Settings → Access Tokens → **New token**, type **Fine-grained**, give it *read* access to your
   repos. This one lives inside the Space, so it must not be the write token.
4. Publish (index ~1 GB upload + the Space):
   ```bash
   python3 scripts/package_index.py      # already done if data/deploy/index/thumbnails.bin exists
   HF_READ_TOKEN=<fine-grained token> BACKEND_API_KEY=$(openssl rand -hex 16) python3 scripts/publish_hf.py
   ```
   Note the `BACKEND_API_KEY` value it printed; Vercel needs the same one.
5. Wait for the Space build (~10 min): `https://<you>-doppelganger-api.hf.space/readyz` → `{"ready": true, ...}`

## 2. Frontend → Vercel (~5 min)

1. vercel.com → **Continue with GitHub** (the `agrimsharma` account) → Hobby plan (free).
2. **Add New → Project** → import `celebrity-doppelganger` → **Root Directory: `frontend`**.
3. Environment variables:
   | Name | Value |
   |---|---|
   | `BACKEND_URL` | `https://<you>-doppelganger-api.hf.space/match` |
   | `BACKEND_API_KEY` | the value from step 1.4 |
4. **Deploy** → your permanent link is `https://<project>.vercel.app`.
