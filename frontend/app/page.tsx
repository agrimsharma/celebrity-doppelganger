"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CameraCapture, { cameraSupported } from "./CameraCapture";
import Stage, { type FrameRect, type StageHandle } from "./experience/Stage";

// similarity = percentile of this score among the best matches of people NOT in the index
type Match = { name: string; similarity: number; raw_similarity?: number; thumbnail: string | null };
type ApiResponse = { matches: Match[] } | { error: string };

const ERROR_MESSAGES: Record<string, string> = {
  no_face_detected: "We couldn't find a face in that photo. Try a clearer, front-facing shot.",
  low_confidence: "The face in that photo wasn't clear enough to get a confident match.",
  invalid_image: "That doesn't look like a valid image file.",
  image_too_large: "That photo is too large. Please use one under 8 MB.",
  backend_unreachable: "Can't reach the matching server right now.",
  backend_waking: "The matching server is still waking up. Please try again in a minute.",
  server_error: "The matching server hit an error. Please try again.",
};

const REPO_URL = "https://github.com/agrimsharma/celebrity-doppelganger";
const EASE = [0.22, 1, 0.36, 1] as const;
const noopSubscribe = () => () => {};

// The free-tier backend sleeps when idle; the first request after a quiet spell wakes it.
type BackendStatus = "checking" | "waking" | "ready" | "down";
// landing -> searching (camera walks the gallery) -> results (at the wall) -> returning -> landing
type Phase = "landing" | "searching" | "results" | "returning";
const HEALTH_POLL_MS = 5000;
const WAKE_TIMEOUT_MS = 5 * 60 * 1000;

async function backendReady(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return (await res.json()).ready === true;
  } catch {
    return false;
  }
}

async function waitForBackend(timeoutMs = WAKE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await backendReady()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export default function Home() {
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("landing");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [backend, setBackend] = useState<BackendStatus>("checking");
  const [waitingForBackend, setWaitingForBackend] = useState(false);
  const [webgl, setWebgl] = useState<boolean | null>(null);   // null until the stage reports
  const [frames, setFrames] = useState<FrameRect[] | null>(null);
  const stage = useRef<StageHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // false during server rendering (no navigator), real value once hydrated
  const canUseCamera = useSyncExternalStore(noopSubscribe, cameraSupported, () => false);
  const closeCamera = useCallback(() => setCameraOpen(false), []);
  const onSupport = useCallback((ok: boolean) => setWebgl(ok), []);
  const onLayout = useCallback((rects: FrameRect[]) => setFrames(rects), []);

  // ping the backend as soon as the page opens, so a sleeping one starts waking right away
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (await backendReady()) {
        if (!cancelled) setBackend("ready");
        return;
      }
      if (cancelled) return;
      setBackend("waking");
      const ok = await waitForBackend();
      if (!cancelled) setBackend(ok ? "ready" : "down");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleFileSelect(f: File | null) {
    setMatches(null);
    setError(null);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  function anotherPhoto() {
    setPhase("returning");
    setFrames(null);
    stage.current?.back(() => {
      setMatches(null);
      setFile(null);
      setPreview(null);
      setPhase("landing");
    });
  }

  async function postMatch(base64: string): Promise<ApiResponse> {
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64 }),
    });
    return res.json();
  }

  async function handleSubmit() {
    if (!file || phase !== "landing") return;
    setPhase("searching");
    setError(null);
    setMatches(null);
    if (webgl) stage.current?.startSearch();

    let failure: string | null = null;
    try {
      const base64 = await fileToBase64(file);
      if (backend !== "ready") {
        setWaitingForBackend(true);
        const ok = await waitForBackend();
        setWaitingForBackend(false);
        setBackend(ok ? "ready" : "down");
      }
      let data = await postMatch(base64);
      if ("error" in data && data.error === "backend_waking") {
        // went to sleep between the health check and the request: wait once more, retry once
        setWaitingForBackend(true);
        await waitForBackend();
        setWaitingForBackend(false);
        data = await postMatch(base64);
      }
      if ("error" in data) {
        failure = ERROR_MESSAGES[data.error] ?? "Something went wrong. Please try another photo.";
      } else {
        setMatches(data.matches);
        if (webgl) {
          stage.current?.showResults(data.matches.map((m) => m.thumbnail), preview, () => setPhase("results"));
        } else {
          setPhase("results");
        }
      }
    } catch {
      failure = "Couldn't reach the server. Please try again.";
    }
    if (failure) {
      setError(failure);
      if (webgl) stage.current?.back(() => setPhase("landing"));
      else setPhase("landing");
    }
  }

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-ink">
      <Stage ref={stage} onSupport={onSupport} onLayout={onLayout} />
      {/* a soft darkening at the edges, so the UI always has contrast against the scene */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(4,6,12,0.55)_100%)]" />

      <Header backend={backend} dim={phase !== "landing"} wordmark={phase !== "landing"} />

      <AnimatePresence mode="wait">
        {phase === "landing" && (
          <Landing
            key="landing"
            preview={preview}
            fileChosen={!!file}
            canUseCamera={canUseCamera}
            error={error}
            onPick={() => inputRef.current?.click()}
            onCamera={() => setCameraOpen(true)}
            onFind={handleSubmit}
          />
        )}
        {phase === "searching" && <Searching key="searching" waking={waitingForBackend} />}
        {phase === "results" && matches && (
          <Results
            key="results"
            matches={matches}
            frames={webgl ? frames : null}
            preview={preview}
            onAgain={anotherPhoto}
          />
        )}
      </AnimatePresence>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={(e) => {
          handleFileSelect(e.target.files?.[0] ?? null);
          e.target.value = "";  // choosing the same file again should still fire
        }}
      />

      <AnimatePresence>
        {cameraOpen && (
          <CameraCapture
            onClose={closeCamera}
            onCapture={(f) => {
              handleFileSelect(f);
              setCameraOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ----------------------------------------------------------------------------- header
function Header({ backend, dim, wordmark }: { backend: BackendStatus; dim: boolean; wordmark: boolean }) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: dim ? 0.55 : 1, y: 0 }}
      transition={{ duration: 1.2, ease: EASE, delay: 0.2 }}
      className="fixed inset-x-0 top-0 z-20 flex items-center justify-between gap-4 px-5 py-5 sm:px-10"
    >
      <span className={`font-display text-lg tracking-[0.28em] text-ivory transition-opacity duration-700 ${wordmark ? "opacity-100" : "opacity-0"}`}>DOPPELGÄNGER</span>
      <span className="eyebrow hidden md:block">139,845 faces · 36,310 people · ArcFace</span>
      <div className="flex items-center gap-5">
        <BackendStatusDot status={backend} />
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="eyebrow transition-colors hover:text-ivory">
          Source ↗
        </a>
      </div>
    </motion.header>
  );
}

function BackendStatusDot({ status }: { status: BackendStatus }) {
  const styles: Record<BackendStatus, [string, string]> = {
    checking: ["bg-ivory/40", "Connecting"],
    waking: ["bg-amber-300 animate-pulse", "Waking the model"],
    ready: ["bg-emerald-300", "Model ready"],
    down: ["bg-red-400", "Model offline"],
  };
  const [dot, label] = styles[status];
  return (
    <span className="eyebrow inline-flex items-center gap-2" role="status">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------- landing
function Landing({
  preview, fileChosen, canUseCamera, error, onPick, onCamera, onFind,
}: {
  preview: string | null;
  fileChosen: boolean;
  canUseCamera: boolean;
  error: string | null;
  onPick: () => void;
  onCamera: () => void;
  onFind: () => void;
}) {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.6, ease: EASE } }}
      className="pointer-events-none relative z-10 flex h-dvh flex-col justify-between px-5 pb-5 pt-20 md:grid md:grid-cols-[1fr_minmax(0,1.15fr)_1fr] md:items-center md:px-10 md:pb-0 md:pt-0"
    >
      {/* a film poster: the title on the left, the head in the middle, the controls on the right */}
      <Title delay={0.35} />

      <div className="hidden md:block" aria-hidden />

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, ease: EASE, delay: 0.75 }}
        className="glass pointer-events-auto mx-auto mt-auto flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl p-5 md:mr-0 md:mt-0 md:max-w-[19rem] md:gap-5 md:p-6"
      >
        <button
          onClick={onPick}
          className="group relative hidden h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-full border border-dashed border-ivory/25 bg-white/[0.03] transition-colors hover:border-ivory/50 md:flex"
          aria-label={preview ? "Change photo" : "Choose a photo"}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your photo" className="h-full w-full object-cover" />
          ) : (
            <span className="font-display text-4xl font-light text-ivory/40 transition-colors group-hover:text-ivory">+</span>
          )}
        </button>

        <div className="flex w-full items-center gap-2">
          {preview && (
            // on phones the preview sits inline, to keep the panel short
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover md:hidden" />
          )}
          <button onClick={onPick} className="btn-quiet flex-1 whitespace-nowrap rounded-full px-3 py-2.5 text-sm">
            {preview ? "Change photo" : "Upload photo"}
          </button>
          {canUseCamera && (
            <button onClick={onCamera} className="btn-quiet inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full px-3 py-2.5 text-sm">
              <CameraIcon /> Camera
            </button>
          )}
        </div>

        <button
          onClick={onFind}
          disabled={!fileChosen}
          className="btn-primary w-full rounded-full px-6 py-3.5 text-sm font-semibold tracking-wide"
        >
          Find my doppelgänger →
        </button>

        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="w-full rounded-lg border border-red-300/20 bg-red-400/10 px-4 py-3 text-sm text-red-100"
              role="alert"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.section>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: 1.1 }}
        className="pointer-events-auto mt-4 text-center text-[0.62rem] leading-relaxed text-ivory/35 md:absolute md:inset-x-0 md:bottom-5 md:mt-0"
      >
        Photos are processed in memory and never stored · IMDB-WIKI, academic use · head scan: Lee
        Perry-Smith (Infinite Realities), CC BY 3.0
      </motion.p>
    </motion.main>
  );
}

function Title({ delay }: { delay: number }) {
  const lines: [string, boolean][] = [["Doppel", false], ["gänger", true]];
  return (
    <div className="text-center md:text-left">
      <h1 className="font-display text-[clamp(3.6rem,8.2vw,8.75rem)] font-light leading-[0.86] tracking-[0.005em] text-ivory">
        {lines.map(([word, italic], i) => (
          <span key={word} className="-mb-[0.22em] block overflow-hidden pb-[0.22em]">
            <motion.span
              className={`block ${italic ? "italic md:pl-[0.5em]" : ""}`}
              initial={{ y: "105%" }}
              animate={{ y: 0 }}
              transition={{ duration: 1.3, ease: EASE, delay: delay + i * 0.12 }}
            >
              {word}
            </motion.span>
          </span>
        ))}
      </h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: delay + 0.6 }}
        className="eyebrow mt-6 md:mt-9"
      >
        Every face has a double
      </motion.p>
    </div>
  );
}

// --------------------------------------------------------------------------- searching
function Searching({ waking }: { waking: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.8, duration: 1 } }}
      exit={{ opacity: 0, transition: { duration: 0.5 } }}
      className="pointer-events-none fixed inset-x-0 bottom-10 z-10 flex flex-col items-center gap-3 px-6 text-center"
      role="status"
    >
      <p className="font-display text-2xl font-light italic text-ivory/90 sm:text-3xl">
        {waking ? "Opening the gallery…" : "Searching 139,845 faces…"}
      </p>
      <p className="eyebrow">
        {waking ? "The model sleeps when nobody visits — waking it takes about 20 seconds" : "Comparing your face with every portrait"}
      </p>
      <div className="relative mt-1 h-px w-48 overflow-hidden bg-ivory/15">
        <motion.div
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-brass to-transparent"
          animate={{ x: ["-100%", "300%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </motion.div>
  );
}

// ----------------------------------------------------------------------------- results
const RANK_LABEL = ["The closest match", "Second", "Third"];

function Results({
  matches, frames, preview, onAgain,
}: {
  matches: Match[];
  frames: FrameRect[] | null;
  preview: string | null;
  onAgain: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.5 } }}
      className="fixed inset-0 z-10"
    >
      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, ease: EASE }}
        className="pointer-events-none absolute inset-x-0 top-20 text-center font-display text-3xl font-light text-ivory sm:top-24 sm:text-5xl"
      >
        Your <em className="italic">doppelgängers</em>
      </motion.h2>

      {frames ? (
        <>
          {/* the best match sits above you: its plaque goes beside it; the others' below */}
          {matches.slice(0, 3).map((m, rank) => {
            const f = frames[rank];
            if (!f) return null;
            const beside = rank === 0;
            return (
              <motion.div
                key={m.name + rank}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.15 + rank * 0.18 }}
                style={beside
                  ? { left: f.x + f.width + 22, top: f.y + f.height / 2 }
                  : { left: f.x + f.width / 2, top: f.y + f.height + 22 }}
                className={`pointer-events-none absolute w-max max-w-[30vw] ${beside ? "-translate-y-1/2 text-left" : "-translate-x-1/2 text-center"}`}
              >
                <Plaque match={m} rank={rank} align={beside ? "start" : "center"} />
              </motion.div>
            );
          })}
          {frames[3] && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.9, ease: EASE }}
              style={{ left: frames[3].x + frames[3].width / 2, top: frames[3].y + frames[3].height + 12 }}
              className="eyebrow pointer-events-none absolute -translate-x-1/2 text-ivory/70"
            >
              You
            </motion.span>
          )}
        </>
      ) : (
        // no WebGL: the same results as plain cards
        <div className="absolute inset-x-0 top-40 flex flex-wrap items-start justify-center gap-6 px-6">
          {matches.slice(0, 3).map((m, rank) => (
            <div key={m.name + rank} className="flex w-44 flex-col items-center gap-3">
              <div className="aspect-[3/4] w-full overflow-hidden rounded-sm border-4 border-brass/70 bg-black">
                {m.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.thumbnail} alt={m.name} className="h-full w-full object-cover" />
                )}
              </div>
              <Plaque match={m} rank={rank} />
            </div>
          ))}
        </div>
      )}

      {preview && !frames && (
        <motion.figure
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 1, ease: EASE, delay: 0.6 }}
          className="glass absolute bottom-6 left-5 hidden items-center gap-3 rounded-full py-1.5 pl-1.5 pr-4 sm:flex"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Your photo" className="h-10 w-10 rounded-full object-cover" />
          <figcaption className="eyebrow">You</figcaption>
        </motion.figure>
      )}

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, ease: EASE, delay: 0.8 }}
        className="absolute inset-x-0 bottom-6 flex flex-col items-center gap-3 px-6 text-center"
      >
        <button onClick={onAgain} className="btn-primary rounded-full px-7 py-3 text-sm font-semibold tracking-wide">
          Try another photo
        </button>
        <p className="max-w-md text-[0.7rem] leading-relaxed text-ivory/45">
          Match strength compares your score with the best matches of thousands of people who
          aren&apos;t in the dataset: 80% means your match is closer than 80% of theirs.
        </p>
      </motion.div>
    </motion.div>
  );
}

function Plaque({ match, rank, align = "center" }: { match: Match; rank: number; align?: "start" | "center" }) {
  return (
    <div className={`flex flex-col gap-1 ${align === "start" ? "items-start" : "items-center"}`}>
      <span className="eyebrow text-brass/90">{RANK_LABEL[rank] ?? `No. ${rank + 1}`}</span>
      <span className={`font-display font-normal leading-tight text-ivory ${rank === 0 ? "text-2xl sm:text-3xl" : "text-lg sm:text-xl"}`}>
        {match.name}
      </span>
      <span className="text-xs tabular-nums text-ivory/60">{Math.round(match.similarity * 100)}% match strength</span>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

// Downscale before upload: phone photos are often 4-12 MB, which exceeds Vercel's ~4.5 MB
// request limit once base64-encoded, and the detector runs at 320px anyway.
const MAX_UPLOAD_DIM = 1024;

async function fileToBase64(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_UPLOAD_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    // formats the browser can't decode (e.g. some HEIC): send as-is, backend reports invalid_image
    return readAsDataUrl(file);
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
