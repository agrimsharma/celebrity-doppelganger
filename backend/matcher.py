"""Index search + score calibration. No face-model dependency, so it's unit-testable."""
import base64
import json
import os
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CALIBRATION = os.path.join(HERE, "calibration.json")


class Calibration:
    """Maps a raw cosine score to its percentile among strangers' best-match scores."""

    def __init__(self, quantiles: List[float]):
        q = np.asarray(quantiles, dtype=np.float64)
        if len(q) < 2 or np.any(np.diff(q) < 0):
            raise ValueError("quantiles must be a non-decreasing list")
        self.quantiles = q
        self.levels = np.linspace(0.0, 1.0, len(q))

    @classmethod
    def load(cls, path: str = DEFAULT_CALIBRATION) -> "Calibration":
        with open(path) as f:
            return cls(json.load(f)["quantiles"])

    def __call__(self, raw: float) -> float:
        return float(np.interp(raw, self.quantiles, self.levels))


class Index:
    def __init__(self, embeddings: np.ndarray, names: List[str], thumbnails: List[str],
                 thumb_dir: Optional[str], calibration: Calibration):
        if len(embeddings) != len(names) or len(names) != len(thumbnails):
            raise ValueError("embeddings/manifest length mismatch")
        self.embeddings = np.ascontiguousarray(embeddings, dtype=np.float32)
        self.names = np.asarray(names, dtype=object)
        self.thumbnails = np.asarray(thumbnails, dtype=object)
        self.thumb_dir = thumb_dir
        self.calibration = calibration

    @classmethod
    def load(cls, index_dir: str, thumb_dir: str, calibration: Calibration) -> "Index":
        emb = np.load(os.path.join(index_dir, "embeddings.npy"))
        manifest = pd.read_csv(os.path.join(index_dir, "manifest.csv"), encoding="utf-8")
        return cls(emb, manifest["name"].astype(str).tolist(), manifest["thumbnail"].tolist(),
                   thumb_dir, calibration)

    def __len__(self):
        return len(self.embeddings)

    def top_k(self, query: np.ndarray, k: int = 3, pool: int = 50) -> List[Dict]:
        """Top-k distinct celebrities - a person with 200 photos can't fill every slot."""
        with np.errstate(all="ignore"):  # spurious macOS Accelerate matmul warnings
            sims = self.embeddings @ query.astype(np.float32)
        # a query close to one or two celebrities with 100+ photos each can fill the whole
        # candidate pool with just those names, so widen the pool until k distinct names appear
        while True:
            pool = min(pool, len(sims))
            cand = np.argpartition(-sims, pool - 1)[:pool]
            cand = cand[np.argsort(-sims[cand])]
            picked, seen = [], set()
            for i in cand:
                if self.names[i] not in seen:
                    seen.add(self.names[i])
                    picked.append(i)
                    if len(picked) == k:
                        break
            if len(picked) == k or pool == len(sims):
                break
            pool *= 10

        return [{
            "name": self.names[i],
            "similarity": round(self.calibration(float(sims[i])), 4),
            "raw_similarity": round(float(sims[i]), 4),
            "thumbnail": self._thumbnail(self.thumbnails[i]),
        } for i in picked]

    def _thumbnail(self, filename: str) -> Optional[str]:
        if not self.thumb_dir:
            return None
        path = os.path.join(self.thumb_dir, filename)
        if not os.path.exists(path):
            return None
        with open(path, "rb") as f:
            return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
