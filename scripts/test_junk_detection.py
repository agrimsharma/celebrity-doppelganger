import os
import cv2
import pandas as pd
from insightface.app import FaceAnalysis

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "raw", "wiki_crop", "wiki_crop")
JUNK_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed", "suspected_junk.csv")

df = pd.read_csv(JUNK_PATH, encoding="utf-8")
print(f"Testing modern detector against {len(df)} heuristically-flagged junk images...\n")

app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))

for _, row in df.iterrows():
    img_path = os.path.join(BASE, row["path"])
    img = cv2.imread(img_path)
    faces = app.get(img) if img is not None else []
    print(f"{row['path']} ({row['reason']}, old face_score={row['face_score']}): "
          f"modern detector found {len(faces)} face(s)")
