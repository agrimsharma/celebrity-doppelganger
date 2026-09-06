import time
import sys
sys.path.insert(0, "scripts")
t0 = time.time()
from match import load_index, embed_query, top_k_matches
from insightface.app import FaceAnalysis
t1 = time.time()
print(f"Import: {t1-t0:.2f}s")

app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))
t2 = time.time()
print(f"Model load: {t2-t1:.2f}s")

embeddings, manifest = load_index()
t3 = time.time()
print(f"Index load ({len(embeddings)} vectors): {t3-t2:.2f}s")

query_emb = embed_query(app, "data/raw/wiki_crop/wiki_crop/33/3553733_1968-04-19_2008.jpg")
t4 = time.time()
print(f"Query embed (detect+align+embed): {t4-t3:.2f}s")

results = top_k_matches(query_emb, embeddings, manifest, k=5)
t5 = time.time()
print(f"Similarity search: {t5-t4:.4f}s")
print(f"\nTotal cold: {t5-t0:.2f}s")
print(f"Warm (query+search only, model+index already loaded): {t5-t3:.2f}s")
