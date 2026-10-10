# The interface: design and build notes

The app's front end was redesigned from a plain upload form into a short, continuous 3D film. This document explains what it does, how it's built, and how it got there: five rounds of design, each driven by feedback on a live preview.

Code: `frontend/app/experience/engine.ts` (the 3D world), `frontend/app/experience/Stage.tsx` (the React wrapper) and `frontend/app/page.tsx` (the HTML UI on top).

## What the visitor sees

| | | | |
|---|---|---|---|
| ![Landing](screenshots/app-home.jpg) | ![The gallery](screenshots/app-gallery.jpg) | ![Assembling](screenshots/app-assembling.jpg) | ![Results](screenshots/app-results.jpg) |
| **1. Landing** | **2. The search flight** | **3. The turn and assembly** | **4. Results** |

1. **Landing: a film poster.** The title *Doppel / gänger* is on the left, a head made of 16,000 points of light is in the middle, and the upload controls are on the right. The head faces the viewer and turns to follow the cursor. Dust drifts off it like smoke.
2. **The search flight.** On *Find*, the head bursts past the camera, and the camera glides at a steady speed through an endless gallery of light: portraits drawn as dots inside thin frames of light. The camera weaves gently left and right, up and down, and banks into each curve. The flight lasts as long as the search does.
3. **The turn.** Once the matches arrive, the camera flies one more stretch, then banks round to a composition that was out of sight, 90° off the flight path. Each frame assembles out of a particle cloud, each point coloured from its photo, and then the real photo resolves.
4. **Results.** Your photo is in the centre. The closest match is above you, with the second and third lower left and right, joined to you by lines of light. Names, ranks and match strength are HTML plaques placed under each frame.

On a phone the layout stacks (title, head, controls). With *prefers-reduced-motion* the flight becomes still cuts. Browsers without WebGL get a plain HTML results grid.

## How it's built

**Plain three.js (r186), no 3D framework.** Every element has its own small GLSL shader:

| Element | How |
|---|---|
| Head | 16,000 points sampled from a 3D head scan (`scripts/build_head_points.py`), stored as a 141 KB binary of int16 positions and int8 normals. Lit per point from its normal: a warm key light plus a cool rim. |
| Dust | Points born on the face where the face *was* at their birth. A 32-step history of the head's pose (one every 0.2 s) is passed to the shader, so dust trails behind a turning head instead of moving rigidly with it. |
| Gallery | 10 portraits recycled around the camera: each sits at `offset - distance travelled`, wrapped over a 30-unit loop, so the gallery never runs out. They fade in from the haze by distance. |
| Stars | Wrapped around the camera in the shader (`mod(position - camera, 120)`), so the starfield is endless but keeps its parallax. |
| Sky | A sphere that follows the camera, with fbm noise for nebular haze and soft diagonal light shafts. |
| Assembly | 64×64 points per frame, 4 frames. Each point flies from a cloud to its pixel and reads its colour from the photo texture in the vertex shader. Photos are centre-cropped to squares on a canvas first. |
| Post-processing | Bloom (strong for starlight, turned down once photos resolve), plus a film pass: slight chromatic aberration, vignette, grain, and a fade to black for cuts. |

**The camera is a small state machine:** `landing → cruise → turning → arrived → leaving`.

- **Cruise:** the speed eases up to 4.2 units/s and stays there; the position is a pure function of the distance travelled.
- **Turning:** a cubic Bézier whose first control point is set so the camera leaves the cruise at exactly its cruising speed, easing to a stop facing the composition. The look target blends from straight ahead to the composition.
- **Arrived:** the stop distance is computed from the field of view and aspect ratio, so the whole composition fits any screen.
- **Leaving:** a fade through black, a camera reset, and the head re-forms.

**Performance.**
- three.js is code-split with a dynamic import, so the page itself is 45 KB gzipped and usable before the 3D loads.
- Phones draw fewer points: the head binary is shuffled, so any prefix is an even subsample.
- If frames run slow for two seconds, the renderer drops its pixel ratio (once).
- It runs at 60 fps on a laptop GPU.

**The HTML layer.** The page tells the engine what to do (`startSearch`, `showResults`, `back`). The engine reports back where the frames landed on screen (projected from the final camera pose), and the page places its plaques there.

**Testing.**
- Playwright drives headless Chrome on the Metal GPU to record the full journey as video and screenshots, at desktop, laptop and phone sizes, with reduced motion, and with a failing search.
- A small fake backend serves fixed matches with a configurable delay, so long and short searches can both be tested.

## How it evolved

Each round was previewed on a Vercel branch deployment and a recorded video before going live.

**Round 1: particle head and a museum walk-through.**
- The landing became a particle head that follows the cursor.
- On *Find*, the camera walked through a museum and stopped at a wall with three framed paintings.
- *Feedback:* the warm museum didn't fit the night-space look; the head was turned to one side; the dust moved rigidly with the head.

**Round 2: the gallery of light.**
- The museum was replaced by an open gallery of light floating in space.
- The head was rotated to face the viewer.
- The dust moved to world space with the pose history described above, so it trails off like smoke.

**Round 3: an endless flight and a hidden composition.**
- *Feedback:* the flight slowed down while waiting for results; the final frames were visible in the distance before arriving; the user's own photo was missing.
- *Changes:*
  - The flight now runs at a constant speed for as long as the search takes, with one more stretch after the results arrive.
  - The final frames are only placed when the turn begins, 90° off the flight line, so they can't be seen early.
  - The composition gained the user's photo in the centre, with the three matches in a triangle round it.

**Round 4: polish.**
- *Feedback:* the glow on the final photos made faces hard to see against white backgrounds; the camera felt static during the search.
- *Changes:*
  - Bloom, halo and leftover-particle brightness over resolved photos were reduced.
  - The cruise gained a gentle weave and bank, which levels out before the turn so there's no jump.

**Round 5: a simpler landing.**
- The landing was reduced to a poster layout: big title left, head centre, upload controls right.
- The explanatory text was removed (the results page explains match strength), keeping one footer line for privacy and the head-scan credit.
- A follow-up fix gave the title's descenders room inside the slide-up reveal mask, which had been clipping the tails of the "g"s and "p"s.

## Related backend change: enforcing the API key

During the same period, the backend's API key, which had been defined but not checked, was made mandatory. It was rolled out safely:

1. The backend gained a **report-only mode** (`API_KEY_MODE=report`): requests without a valid key are counted in a Prometheus metric (`doppelganger_api_key_checks_total{result}`) but still served.
2. Once the counter showed only valid keys from the frontend, the mode was switched to **enforce**, which returns 401 for a missing or wrong key.

Keys are compared with `hmac.compare_digest`. The key lives in a Modal secret and a Vercel environment variable, and is never in the repo.

## Credits

The head is sampled from "Infinite, 3D Head Scan" by Lee Perry-Smith (Infinite Realities), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), via the three.js examples. Only the derived point cloud ships. In the screenshots, the visitor's photo is blurred.
