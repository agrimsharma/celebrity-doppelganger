import os
import cv2
import pandas as pd
from insightface.app import FaceAnalysis

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
JUNK_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "suspected_junk.csv")
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "wiki_manifest.csv")

junk_df = pd.read_csv(JUNK_PATH, encoding="utf-8")
manifest_df = pd.read_csv(MANIFEST_PATH, encoding="utf-8")
# control sample: 20 images with high original face_score, presumably clean real photos
control_df = manifest_df.sort_values("face_score", ascending=False).head(20)

app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))

def check(path):
    img = cv2.imread(os.path.join(BASE, path))
    if img is None:
        return None
    faces = app.get(img)
    if not faces:
        return []
    return [round(float(f.det_score), 4) for f in faces]

print("=== Flagged junk images (det_score) ===")
for _, row in junk_df.iterrows():
    scores = check(row["path"])
    print(f"{row['path']} ({row['reason']}): det_score={scores}")

print("\n=== Control: 20 high original-face_score (presumed clean) images ===")
control_scores = []
for _, row in control_df.iterrows():
    scores = check(row["path"])
    if scores:
        control_scores.extend(scores)
    print(f"{row['path']}: det_score={scores}")

print(f"\nControl det_score range: min={min(control_scores):.4f}, max={max(control_scores):.4f}, "
      f"mean={sum(control_scores)/len(control_scores):.4f}")
