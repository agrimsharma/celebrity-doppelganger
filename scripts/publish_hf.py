"""
Publish the free-tier backend to Hugging Face (no card needed, ever):
  1. PRIVATE dataset  <user>/doppelganger-index  <- data/deploy/index (run package_index.py first)
  2. PUBLIC Docker Space <user>/doppelganger-api  <- deploy/hf-space + backend/
  3. Space settings: INDEX_REPO variable, and (optional) the HF_TOKEN / API_KEY secrets

Prereqs (you, once):  pip install huggingface_hub  &&  hf auth login   (a WRITE token)

The Space needs a READ token to fetch the private index. Create a fine-grained token at
https://huggingface.co/settings/tokens with read access to the dataset, then either add it in the
Space's Settings -> Secrets as HF_TOKEN, or pass it here and the script sets it for you:
  HF_READ_TOKEN=hf_... BACKEND_API_KEY=<any secret> python scripts/publish_hf.py
"""
import os
import shutil
import tempfile

from huggingface_hub import HfApi

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
INDEX_DIR = os.path.join(ROOT, "data", "deploy", "index")
SPACE_DIR = os.path.join(ROOT, "deploy", "hf-space")


def main():
    api = HfApi()
    user = api.whoami()["name"]
    dataset, space = f"{user}/doppelganger-index", f"{user}/doppelganger-api"

    if not os.path.exists(os.path.join(INDEX_DIR, "thumbnails.bin")):
        raise SystemExit("run python scripts/package_index.py first")

    print(f"1/3 private dataset {dataset} (~1 GB upload)")
    api.create_repo(dataset, repo_type="dataset", private=True, exist_ok=True)
    api.upload_folder(repo_id=dataset, repo_type="dataset", folder_path=INDEX_DIR,
                      commit_message="Upload packed face index")

    print(f"2/3 Space {space}")
    api.create_repo(space, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for f in os.listdir(SPACE_DIR):
            shutil.copy2(os.path.join(SPACE_DIR, f), tmp)
        shutil.copytree(os.path.join(ROOT, "backend"), os.path.join(tmp, "backend"),
                        ignore=shutil.ignore_patterns("tests", "__pycache__", "Dockerfile", "requirements-dev.txt"))
        api.upload_folder(repo_id=space, repo_type="space", folder_path=tmp, commit_message="Deploy backend")

    print("3/3 Space settings")
    api.add_space_variable(space, "INDEX_REPO", dataset)
    if os.environ.get("HF_READ_TOKEN"):
        api.add_space_secret(space, "HF_TOKEN", os.environ["HF_READ_TOKEN"])
    else:
        print("   ! add a READ token as the Space secret HF_TOKEN (Settings -> Secrets), then restart the Space")
    if os.environ.get("BACKEND_API_KEY"):
        api.add_space_secret(space, "API_KEY", os.environ["BACKEND_API_KEY"])

    url = f"https://{user}-doppelganger-api.hf.space"
    print(f"\nSpace:   https://huggingface.co/spaces/{space}  (first build takes ~5-10 min)")
    print(f"Vercel:  BACKEND_URL={url}/match   BACKEND_HEALTH_URL={url}/readyz"
          + ("   BACKEND_API_KEY=<same value>" if os.environ.get("BACKEND_API_KEY") else ""))


if __name__ == "__main__":
    main()
