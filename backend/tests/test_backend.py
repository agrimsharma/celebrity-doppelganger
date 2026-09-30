"""Backend tests - a synthetic index and a fake face model, so they run without insightface
or the (gitignored) dataset."""
import base64

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend.matcher import Calibration, Index

DIM = 8


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def make_index(thumb_dir=None):
    rng = np.random.default_rng(0)
    base = unit(rng.normal(size=DIM))
    emb = np.stack([
        unit(base + 0.01 * rng.normal(size=DIM)),  # Alice, closest
        unit(base + 0.02 * rng.normal(size=DIM)),  # Alice again - must be deduped
        unit(base + 0.30 * rng.normal(size=DIM)),  # Bob
        unit(rng.normal(size=DIM)),                # Carol
        unit(rng.normal(size=DIM)),                # Dave
    ])
    names = ["Alice", "Alice", "Bob", "Carol", "Dave"]
    thumbs = [f"{i}.jpg" for i in range(len(names))]
    return Index(emb, names, thumbs, thumb_dir, Calibration([0.0, 0.3, 1.0])), base


class FakeEmbedder:
    def __init__(self, result):
        self.result = result

    def best_face(self, img):
        return self.result


def png_data_uri():
    ok, buf = cv2.imencode(".png", np.full((16, 16, 3), 127, dtype=np.uint8))
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


# --- matcher ---------------------------------------------------------------------------

def test_calibration_is_percentile_of_stranger_scores():
    cal = Calibration([0.2, 0.3, 0.4])
    assert cal(0.1) == 0.0          # below every stranger's best match
    assert cal(0.3) == pytest.approx(0.5)
    assert cal(0.9) == 1.0


def test_calibration_rejects_unsorted_quantiles():
    with pytest.raises(ValueError):
        Calibration([0.3, 0.2])


def test_top_k_dedupes_names_and_orders_by_score():
    index, query = make_index()
    matches = index.top_k(query, k=3)
    names = [m["name"] for m in matches]
    assert names[0] == "Alice" and names[1] == "Bob"
    assert len(set(names)) == 3
    raws = [m["raw_similarity"] for m in matches]
    assert raws == sorted(raws, reverse=True)
    assert all(0.0 <= m["similarity"] <= 1.0 for m in matches)


def test_top_k_handles_pool_larger_than_index():
    index, query = make_index()
    assert len(index.top_k(query, k=10, pool=500)) == 4  # only 4 distinct names exist


def test_top_k_widens_pool_when_one_name_dominates():
    index, query = make_index()
    # pool=2 holds only the two Alice photos; the search must widen to still find 3 names
    assert len(index.top_k(query, k=3, pool=2)) == 3


def test_thumbnail_embedded_as_data_uri(tmp_path):
    (tmp_path / "0.jpg").write_bytes(b"\xff\xd8fake")
    index, query = make_index(str(tmp_path))
    top = index.top_k(query, k=1)[0]
    assert top["thumbnail"].startswith("data:image/jpeg;base64,")


# --- API -------------------------------------------------------------------------------

@pytest.fixture
def client_with(monkeypatch):
    def make(face_result):
        index, query = make_index()
        result = face_result(query) if callable(face_result) else face_result
        monkeypatch.setitem(app_module.state, "index", index)
        monkeypatch.setitem(app_module.state, "embedder", FakeEmbedder(result))
        return TestClient(app_module.app)
    return make


def test_match_returns_three_matches(client_with):
    with client_with(lambda q: (q, 0.9)) as client:
        r = client.post("/match", json={"image": png_data_uri()})
    assert r.status_code == 200
    assert [m["name"] for m in r.json()["matches"]][:2] == ["Alice", "Bob"]


def test_no_face(client_with):
    with client_with(None) as client:
        assert client.post("/match", json={"image": png_data_uri()}).json() == {"error": "no_face_detected"}


def test_low_confidence_face(client_with):
    with client_with(lambda q: (q, 0.5)) as client:
        assert client.post("/match", json={"image": png_data_uri()}).json() == {"error": "low_confidence"}


@pytest.mark.parametrize("payload", [{"image": "not-a-data-uri"}, {"image": "data:image/png;base64,@@@"}, {}])
def test_invalid_image(client_with, payload):
    with client_with(None) as client:
        r = client.post("/match", json=payload)
    assert r.status_code == 400 and r.json() == {"error": "invalid_image"}


def test_oversized_upload_rejected(client_with, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_IMAGE_BYTES", 100)
    with client_with(None) as client:
        r = client.post("/match", json={"image": "data:image/png;base64," + "A" * 400})
    assert r.status_code == 413


def test_api_key_required_when_configured(client_with, monkeypatch):
    monkeypatch.setattr(app_module, "API_KEY", "s3cret")
    with client_with(lambda q: (q, 0.9)) as client:
        assert client.post("/match", json={"image": png_data_uri()}).status_code == 401
        r = client.post("/match", json={"image": png_data_uri()}, headers={"X-API-Key": "s3cret"})
    assert r.status_code == 200


def test_probes(client_with):
    with client_with(None) as client:
        assert client.get("/healthz").status_code == 200
        r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["index_faces"] == 5
