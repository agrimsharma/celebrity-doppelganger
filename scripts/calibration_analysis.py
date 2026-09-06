import os
import numpy as np
import pandas as pd

CONSOLIDATED_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "consolidated")

embeddings = np.load(os.path.join(CONSOLIDATED_DIR, "embeddings.npy")).astype(np.float32)
manifest = pd.read_csv(os.path.join(CONSOLIDATED_DIR, "manifest.csv"), encoding="utf-8")
print(f"Loaded {len(embeddings)} embeddings")

name_to_indices = manifest.groupby("name").indices

rng = np.random.default_rng(42)

# --- Category A: same identity, different photo ---
multi_photo_names = [n for n, idxs in name_to_indices.items() if len(idxs) >= 2]
print(f"\nNames with >=2 photos: {len(multi_photo_names)}")

same_identity_sims = []
for name in rng.choice(multi_photo_names, size=min(3000, len(multi_photo_names)), replace=False):
    idxs = name_to_indices[name]
    i, j = rng.choice(idxs, size=2, replace=False)
    same_identity_sims.append(float(embeddings[i] @ embeddings[j]))
same_identity_sims = np.array(same_identity_sims)

# --- Category B: random different people ---
all_names = manifest["name"].values
n = len(embeddings)
random_sims = []
for _ in range(20000):
    i, j = rng.integers(0, n, size=2)
    if all_names[i] == all_names[j]:
        continue
    random_sims.append(float(embeddings[i] @ embeddings[j]))
random_sims = np.array(random_sims)

# --- Category C: known real-world lookalike pairs (different people) ---
lookalike_pairs = [
    ("Jessica Chastain", "Bryce Dallas Howard"),
    ("Katy Perry", "Zooey Deschanel"),
    ("Leighton Meester", "Minka Kelly"),
    ("Sarah Hyland", "Mila Kunis"),
    ("Will Ferrell", "Chad Smith"),
    ("Jennifer Connelly", "Demi Moore"),
    ("Matt Bomer", "Henry Cavill"),
    ("Zach Braff", "Dax Shepard"),
    ("Brittany Murphy", "Lili Reinhart"),
    ("Reese Witherspoon", "Carrie Underwood"),
]

lookalike_sims = []
for a, b in lookalike_pairs:
    if a not in name_to_indices or b not in name_to_indices:
        continue
    idxs_a, idxs_b = name_to_indices[a], name_to_indices[b]
    sims = embeddings[idxs_a] @ embeddings[idxs_b].T
    lookalike_sims.append(float(sims.max()))  # best-matching photo pair for this duo
    print(f"{a} vs {b}: max={sims.max():.3f}, mean={sims.mean():.3f} ({len(idxs_a)}x{len(idxs_b)} photo pairs)")
lookalike_sims = np.array(lookalike_sims)


def stats(name, arr):
    print(f"\n{name} (n={len(arr)}):")
    for p in [5, 25, 50, 75, 90, 95, 99]:
        print(f"  p{p}: {np.percentile(arr, p):.4f}")
    print(f"  mean: {arr.mean():.4f}")


stats("Category A - same identity, different photo", same_identity_sims)
stats("Category B - random different people", random_sims)
stats("Category C - known real-world lookalike pairs", lookalike_sims)

np.savez(os.path.join(CONSOLIDATED_DIR, "calibration_samples.npz"),
         same_identity=same_identity_sims, random=random_sims, lookalike=lookalike_sims)
print("\nSaved raw samples to calibration_samples.npz")
