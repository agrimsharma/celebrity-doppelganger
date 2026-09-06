# IMDB face-embedding job — step by step

Thanks for helping with this! You don't need to understand any of it — just follow the
steps below in order, copy-pasting the commands exactly as written. If anything shows an
error you don't understand, stop and send a screenshot back rather than trying to fix it.

This will use your PC's CPU fairly heavily for a while (could be several hours), so it's
best done when you don't need the machine for anything demanding.

## What you need before starting

- Windows PC
- Python 3.10 or newer installed (if you're not sure, open PowerShell and type `python --version`
  — if that errors, install Python from python.org first, and during install check the box
  that says "Add Python to PATH")
- 7-Zip installed (7-zip.org) — needed because normal Windows extraction can corrupt these files
- At least **15GB of free disk space**
- The 3 files that came with this doc: `build_manifest.py`, `embed_dataset_parallel.py`,
  `requirements.txt`

## Step 1 — Set up a folder

Create a folder anywhere, e.g. `C:\imdb_job\`. Put the 3 files above directly inside it.

## Step 2 — Open PowerShell in that folder

In File Explorer, go into `C:\imdb_job\`, click the address bar, type `powershell`, press Enter.

## Step 3 — Create a Python environment and install packages

Copy-paste this whole block, press Enter, wait for it to finish (a few minutes):

```powershell
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
```

## Step 4 — Download the dataset

Download these two files (right-click → Save As, or just click and let it download) into
`C:\imdb_job\raw\`:

- `https://data.vision.ee.ethz.ch/cvl/rrothe/imdb-wiki/static/imdb_crop.tar` (**7GB — this is the big one, will take a while**)
- `https://data.vision.ee.ethz.ch/cvl/rrothe/imdb-wiki/static/imdb_meta.tar` (small)

Create the `raw` folder first if it doesn't exist.

## Step 5 — Extract both files with 7-Zip

**Important: use 7-Zip, not Windows' built-in "Extract All"** — Windows' own tool is known to
corrupt one of the files in this dataset.

Right-click each `.tar` file → 7-Zip → Extract Here. Extract both `imdb_crop.tar` and
`imdb_meta.tar` inside `C:\imdb_job\raw\`.

## Step 6 — Find the file named `imdb.mat`

After extracting, look inside the folders that appeared and find a file called **`imdb.mat`**
(it might be inside the `imdb_crop` folder, or inside the `imdb_meta` folder — just look in
both). Once you find it, right-click it → Copy as path. You'll need this path in the next step.

## Step 7 — Build the manifest

Run this, but **replace `PASTE_MAT_PATH_HERE` with the path you copied in Step 6** (keep the
quotes around it):

```powershell
.\venv\Scripts\python.exe build_manifest.py "PASTE_MAT_PATH_HERE" imdb C:\imdb_job\imdb_manifest.csv
```

This should print some numbers and finish in under a minute. If it errors, stop and send a screenshot.

## Step 8 — Find the folder containing the actual face images

Look inside `C:\imdb_job\raw\` for a folder that contains subfolders named `00`, `01`, `02`, ...
up to `99`, each full of `.jpg` files. That folder's full path is what you'll use next.
Right-click it → Copy as path.

## Step 9 — Quick test run (do this before the full run)

Replace `PASTE_IMAGE_FOLDER_HERE` with the path from Step 8, then run:

```powershell
.\venv\Scripts\python.exe embed_dataset_parallel.py C:\imdb_job\imdb_manifest.csv "PASTE_IMAGE_FOLDER_HERE" C:\imdb_job\test_chunks 500
```

This processes just 500 images as a test. **It should finish in a few minutes.** If it's still
running after 20 minutes, or it crashes, stop and message back before continuing — something's
not working right and continuing would waste your time.

If it finishes in a reasonable time: delete the test output and move to the real run:

```powershell
Remove-Item -Recurse -Force C:\imdb_job\test_chunks
```

## Step 10 — The real run

```powershell
.\venv\Scripts\python.exe embed_dataset_parallel.py C:\imdb_job\imdb_manifest.csv "PASTE_IMAGE_FOLDER_HERE" C:\imdb_job\imdb_chunks
```

This will take a while — could be several hours depending on your PC. You can just leave it
running in the background and use your computer normally for other things.

**You can safely stop it anytime** (close the PowerShell window, or Ctrl+C) — progress is saved
continuously. To pick back up later, just run the exact same command again; it'll skip
everything already done and continue from where it left off.

To check on progress without stopping it: open a **new** PowerShell window and run:

```powershell
(Get-ChildItem C:\imdb_job\imdb_chunks\*_manifest.csv).Count
```

The number that prints is roughly how many chunks are done (each chunk covers a few hundred
images) — it should keep going up over time.

## Step 11 — When it's done (or whenever you want to send back what's finished)

Right-click the `C:\imdb_job\imdb_chunks` folder → Send to → Compressed (zipped) folder.
Send that zip file back (Google Drive / WeTransfer / whatever's easiest — it should be well
under 1GB, much smaller than the original dataset).

That's it — thank you!
