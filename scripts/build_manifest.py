import sys
import scipy.io
import numpy as np
import pandas as pd
import os


def main():
    if len(sys.argv) < 4:
        print("Usage: python build_manifest.py <mat_file_path> <struct_key: wiki|imdb> <output_csv_path>")
        sys.exit(1)

    mat_path, struct_key, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    mat = scipy.io.loadmat(mat_path)
    data = mat[struct_key][0, 0]
    n = data["full_path"].shape[1]

    rows = []
    for i in range(n):
        full_path = data["full_path"][0, i][0]
        name_arr = data["name"][0, i]
        name = name_arr[0] if name_arr.size else None
        gender = float(data["gender"][0, i])
        face_score = float(data["face_score"][0, i])
        second_face_score = float(data["second_face_score"][0, i])
        photo_taken = int(data["photo_taken"][0, i])
        rows.append({
            "path": full_path,
            "name": name,
            "gender": gender,
            "face_score": face_score,
            "second_face_score": second_face_score,
            "photo_taken": photo_taken,
        })

    df = pd.DataFrame(rows)
    print("Total records:", len(df))

    # Drop rows with no detected face at all (face_score is -inf)
    usable = df[np.isfinite(df["face_score"])].copy()
    print("Usable (finite face_score):", len(usable))

    print("Unique names:", usable["name"].nunique())
    counts = usable["name"].value_counts()
    print("Names with >=2 usable photos:", (counts >= 2).sum())
    print(counts.head(10))

    usable.to_csv(out_path, index=False, encoding="utf-8")
    print("Wrote manifest to", out_path)


if __name__ == "__main__":
    main()
