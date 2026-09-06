import scipy.io
import numpy as np
import os

MAT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop", "wiki.mat")

mat = scipy.io.loadmat(MAT_PATH)
print("Top-level keys:", [k for k in mat.keys() if not k.startswith("__")])

wiki = mat["wiki"]
print("wiki shape:", wiki.shape, "dtype names:", wiki.dtype.names)

data = wiki[0, 0]
fields = wiki.dtype.names
for f in fields:
    arr = data[f]
    print(f"\nField: {f}, shape: {arr.shape}")

n = data["full_path"].shape[1]
print("\nTotal records:", n)

print("\n--- First 5 records ---")
for i in range(5):
    full_path = data["full_path"][0, i][0]
    name = data["name"][0, i]
    name = name[0] if name.size else None
    dob = data["dob"][0, i]
    photo_taken = data["photo_taken"][0, i]
    gender = data["gender"][0, i]
    face_score = data["face_score"][0, i]
    second_face_score = data["second_face_score"][0, i]
    face_location = data["face_location"][0, i]
    print(f"[{i}] path={full_path} name={name} dob={dob} photo_taken={photo_taken} "
          f"gender={gender} face_score={face_score} second_face_score={second_face_score} "
          f"face_location={face_location}")

# quality distribution
face_scores = data["face_score"][0]
second_scores = data["second_face_score"][0]
inf_count = np.sum(np.isinf(face_scores))
nan_second = np.sum(np.isnan(second_scores))
print(f"\nface_score == -inf/inf count: {inf_count} / {n}")
print(f"second_face_score is NaN (single face) count: {nan_second} / {n}")
