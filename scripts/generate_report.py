import os
import base64
import glob
import cv2
from insightface.app import FaceAnalysis

import sys
sys.path.insert(0, os.path.dirname(__file__))
from match import load_index, embed_query, top_k_matches, resolve_image_path

QUERY_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "test_queries")
OUT_HTML = os.path.join(os.path.dirname(__file__), "..", "reports", "match_report.html")

os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)


def to_data_uri(path):
    with open(path, "rb") as f:
        b = f.read()
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    mime = "jpeg" if ext in ("jpg", "jpeg") else ext
    return f"data:image/{mime};base64,{base64.b64encode(b).decode()}"


embeddings, manifest = load_index()
print(f"Loaded {len(embeddings)} reference embeddings")

app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                    providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))

query_paths = sorted(glob.glob(os.path.join(QUERY_DIR, "*.jpg")) +
                      glob.glob(os.path.join(QUERY_DIR, "*.jpeg")) +
                      glob.glob(os.path.join(QUERY_DIR, "*.png")))

rows_html = []
for qpath in query_paths:
    try:
        query_emb = embed_query(app, qpath)
    except ValueError as e:
        rows_html.append(f"""
        <div class="row error">
          <div class="cell"><img src="{to_data_uri(qpath)}"><div class="label">{os.path.basename(qpath)}</div></div>
          <div class="cell error-msg">Error: {e}</div>
        </div>""")
        continue

    top1 = top_k_matches(query_emb, embeddings, manifest, k=1)[0]
    match_img_path = resolve_image_path(top1)
    if match_img_path and os.path.exists(match_img_path):
        match_cell = f"""<img src="{to_data_uri(match_img_path)}">
        <div class="label">{top1['name']}<br><span class="score">similarity: {top1['similarity']:.3f} [{top1['source']}]</span></div>"""
    else:
        match_cell = f"""<div class="no-image">no local photo<br>({top1['source']})</div>
        <div class="label">{top1['name']}<br><span class="score">similarity: {top1['similarity']:.3f} [{top1['source']}]</span></div>"""
    rows_html.append(f"""
    <div class="row">
      <div class="cell">
        <img src="{to_data_uri(qpath)}">
        <div class="label">{os.path.basename(qpath)}</div>
      </div>
      <div class="arrow">&rarr;</div>
      <div class="cell">
        {match_cell}
      </div>
    </div>""")
    print(f"{os.path.basename(qpath)} -> {top1['name']} ({top1['similarity']:.3f}, {top1['source']})")

html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Match Report</title>
<style>
  body {{ font-family: -apple-system, Arial, sans-serif; background: #1a1a1a; color: #eee; padding: 24px; }}
  h1 {{ font-size: 18px; color: #aaa; }}
  .row {{ display: flex; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #333; }}
  .cell {{ text-align: center; }}
  .cell img {{ width: 220px; height: 220px; object-fit: cover; border-radius: 8px; }}
  .arrow {{ font-size: 28px; color: #666; }}
  .label {{ margin-top: 8px; font-size: 14px; }}
  .score {{ color: #999; font-size: 12px; }}
  .error-msg {{ color: #e88; }}
  .no-image {{ width: 220px; height: 220px; display: flex; align-items: center; justify-content: center;
               background: #2a2a2a; border-radius: 8px; color: #777; font-size: 13px; text-align: center; }}
</style></head>
<body>
<h1>Query photo &rarr; #1 match ({len(embeddings)} reference faces indexed)</h1>
{"".join(rows_html)}
</body></html>"""

with open(OUT_HTML, "w", encoding="utf-8") as f:
    f.write(html)
print(f"\nWrote report to {OUT_HTML}")
