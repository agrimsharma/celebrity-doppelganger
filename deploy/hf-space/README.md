---
title: Celebrity Doppelganger API
emoji: 🎭
colorFrom: yellow
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
short_description: ArcFace + cosine search over 140K celebrity faces
---

Matching backend for [celebrity-doppelganger](https://github.com/agrimsharma/celebrity-doppelganger)
(SCRFD detection -> ArcFace embedding -> cosine top-k over 139,845 faces -> calibrated match strength).

- `POST /match` `{"image": "data:image/jpeg;base64,..."}` -> top 3 matches
- `GET /healthz`, `GET /readyz`

Uploads are processed in memory and never stored. The face index (IMDB-WIKI, academic use only)
lives in a private dataset and is not redistributed. The frontend is deployed separately on Vercel.
