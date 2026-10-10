"""
The landing page's particle head: points sampled from a 3D head scan, shipped as a small binary.

  pip install trimesh rtree networkx scipy
  python scripts/build_head_points.py path/to/LeePerrySmith.glb
  -> frontend/public/head-points.bin

Source scan: "Infinite, 3D Head Scan" by Lee Perry-Smith (Infinite Realities), CC BY 3.0, from the
three.js repository (examples/models/gltf/LeePerrySmith). Only this derived point cloud is shipped.

Format (little-endian): uint32 count, then count x int16[3] positions (scaled to [-1, 1] by the
head's largest half-extent), then count x int8[3] unit normals (x127). Area-weighted sampling, so
the density is even over the surface.
"""
import os
import struct
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N_POINTS = 16000
SEED = 11


def drop_hidden_pieces(mesh):
    """The scan includes the inside of the mouth (cavity walls, gums). Solid surfaces hide them,
    but points are see-through, so they showed as a box around the mouth. Drop every separate
    piece that is mostly covered by the face when seen from the front."""
    import trimesh

    pieces = mesh.split(only_watertight=False)
    main_piece = max(pieces, key=lambda p: p.area)
    keep = [main_piece]
    for piece in pieces:
        if piece is main_piece or piece.area < 1e-6:
            continue
        origins = piece.vertices + [0, 0, 1e-3]
        hits = main_piece.ray.intersects_any(origins, np.tile([0.0, 0.0, 1.0], (len(origins), 1)))
        if hits.mean() < 0.6:  # visible from the front: shoulders, eyes
            keep.append(piece)
    return trimesh.util.concatenate(keep)


def main(src: str) -> None:
    import trimesh

    mesh = drop_hidden_pieces(trimesh.load(src, force="mesh"))
    rng = np.random.default_rng(SEED)
    # even density over the surface; the features come from lighting the points by their
    # normals in the shader (curvature-weighted sampling picked up an open edge round the mouth)
    pts, face_idx = trimesh.sample.sample_surface_even(mesh, N_POINTS, seed=SEED)
    normals = mesh.face_normals[face_idx]
    # the scan is 15 separate pieces and ~30% of its faces are wound inside-out, which lit whole
    # patches (e.g. round the mouth) as if they faced away; point every normal away from the
    # head's central axis instead (the bust is convex enough for that to be right)
    outward = pts - mesh.bounds.mean(axis=0)
    outward[:, 1] *= 0.35  # mostly horizontal: the skull top still points up, the jaw still forward
    normals *= np.sign((normals * outward).sum(axis=1, keepdims=True) + 1e-9)

    centre = (mesh.bounds[0] + mesh.bounds[1]) / 2
    scale = (mesh.extents / 2).max()
    pts = (pts - centre) / scale
    order = rng.permutation(len(pts))  # so any prefix is an even subsample (phones draw fewer)
    pts, normals = pts[order], normals[order]

    out = os.path.join(REPO, "frontend", "public", "head-points.bin")
    with open(out, "wb") as f:
        f.write(struct.pack("<I", len(pts)))
        f.write(np.clip(np.round(pts * 32767), -32767, 32767).astype("<i2").tobytes())
        f.write(np.clip(np.round(normals * 127), -127, 127).astype("i1").tobytes())
    print(f"{len(pts)} points -> {out} ({os.path.getsize(out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
