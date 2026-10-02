"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CameraCapture, { cameraSupported } from "./CameraCapture";

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

const ACCENT_CLASSES = ["card-accent-0", "card-accent-1", "card-accent-2"];

const noopSubscribe = () => () => {};

// The free-tier backend (Hugging Face Space) sleeps when idle; waking it takes about a minute.
type BackendStatus = "checking" | "waking" | "ready" | "down";
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
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [backend, setBackend] = useState<BackendStatus>("checking");
  const [waitingForBackend, setWaitingForBackend] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const showResults = matches !== null;

  // false during server rendering (no navigator), real value once hydrated
  const canUseCamera = useSyncExternalStore(noopSubscribe, cameraSupported, () => false);
  const closeCamera = useCallback(() => setCameraOpen(false), []);

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

  function reset() {
    setMatches(null);
    setError(null);
    setFile(null);
    setPreview(null);
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
    if (!file) return;
    setLoading(true);
    setError(null);
    setMatches(null);

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
        setError(ERROR_MESSAGES[data.error] ?? "Something went wrong. Please try another photo.");
      } else {
        setMatches(data.matches);
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center overflow-hidden px-4 py-10">
      <StarAccent className="left-[8%] top-[12%] hidden text-black/70 sm:block" size={28} />
      <StarAccent className="right-[10%] top-[20%] hidden text-black/40 sm:block" size={18} rotate={20} />

      <AnimatePresence>
        {!showResults ? (
          <motion.main
            key="upload"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.25 } }}
            className="flex min-h-[80vh] w-full max-w-md flex-1 flex-col items-center justify-center gap-6"
          >
            <div className="flex w-full flex-col items-center gap-6 rounded-[2rem] solid-card p-8">
              <motion.h1
                animate={{ opacity: loading ? 0.5 : 1 }}
                className="text-center text-3xl font-extrabold tracking-tight text-zinc-900"
              >
                Celebrity Doppelganger Finder
              </motion.h1>
              <p className="text-center text-sm text-zinc-600">
                Upload a photo or take a selfie, and we&apos;ll find your closest match among 140,000 celebrity faces.
              </p>
              <BackendPill status={backend} />

              <div className="relative h-64 w-64">
                <motion.div
                  animate={loading ? {
                    boxShadow: [
                      "0 0 60px 20px rgba(198,242,78,0.7)",
                      "0 0 70px 25px rgba(168,200,245,0.7)",
                      "0 0 70px 25px rgba(247,184,208,0.7)",
                      "0 0 70px 25px rgba(255,90,31,0.7)",
                      "0 0 60px 20px rgba(198,242,78,0.7)",
                    ],
                  } : { boxShadow: "0 10px 30px -5px rgba(0,0,0,0.12)" }}
                  transition={loading ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" } : undefined}
                  className="card-accent-1 relative flex h-64 w-64 cursor-pointer items-center justify-center overflow-hidden rounded-[1.75rem] border-2 border-black/10"
                  onClick={() => !loading && inputRef.current?.click()}
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={preview} alt="Selected preview" className="h-full w-full object-cover" />
                  ) : (
                    <span className="px-6 text-center text-sm font-medium text-zinc-700">
                      Click to select a photo
                    </span>
                  )}
                  {/* scanning light sweep - reinforces "actively analyzing" */}
                  {loading && (
                    <motion.div
                      className="pointer-events-none absolute inset-x-0 h-16 bg-gradient-to-b from-transparent via-white/70 to-transparent"
                      animate={{ top: ["-15%", "105%"] }}
                      transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }}
                    />
                  )}
                </motion.div>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
              />

              {canUseCamera && (
                <button
                  onClick={() => setCameraOpen(true)}
                  disabled={loading}
                  className="-mt-2 inline-flex items-center gap-2 rounded-full border-2 border-black/10 bg-white px-4 py-2 text-sm font-bold text-zinc-700 disabled:opacity-40"
                >
                  <CameraIcon /> Use camera
                </button>
              )}

              <button
                onClick={handleSubmit}
                disabled={!file || loading}
                className="tactile-btn w-full rounded-full bg-[#ff5a1f] px-6 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <motion.span
                      className="h-2 w-2 rounded-full bg-white"
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                    />
                    {waitingForBackend ? "Waking up the model..." : "Finding your match..."}
                  </span>
                ) : (
                  "Find my doppelganger"
                )}
              </button>

              {error && (
                <p className="w-full rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
              )}
            </div>

            <p className="max-w-md text-center text-xs text-zinc-500">
              Demo built on the IMDB-WIKI dataset (academic research use only). Uploaded photos are
              processed in memory and not stored.
            </p>
          </motion.main>
        ) : (
          <motion.main
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.1 } }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            className="flex min-h-[80vh] w-full max-w-4xl flex-1 flex-col items-center justify-center gap-10 pt-16"
          >
            <motion.h2
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="text-center text-2xl font-extrabold tracking-tight text-zinc-900"
            >
              Your celebrity doppelganger{matches!.length > 1 ? "s" : ""}
            </motion.h2>

            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:justify-center sm:gap-4">
              {preview && <UserCard preview={preview} />}

              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="hidden text-2xl font-extrabold text-zinc-400 sm:block"
              >
                vs
              </motion.span>

              <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-end sm:gap-6">
                {matches!.map((m, i) => (
                  <MatchCard key={i} match={m} rank={i} />
                ))}
              </div>
            </div>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="max-w-md text-center text-xs text-zinc-500"
            >
              Match strength compares your score with the best matches of thousands of people who
              aren&apos;t in the dataset: 80% means your match is closer than 80% of theirs.
            </motion.p>

            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              onClick={reset}
              className="tactile-btn rounded-full bg-[#ff5a1f] px-6 py-3 font-bold text-white"
            >
              Try another photo
            </motion.button>
          </motion.main>
        )}
      </AnimatePresence>

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

function BackendPill({ status }: { status: BackendStatus }) {
  const styles: Record<BackendStatus, [string, string]> = {
    checking: ["bg-zinc-300", "Connecting to the model..."],
    waking: ["bg-amber-400 animate-pulse", "Waking up the model (free hosting sleeps when idle, about a minute)"],
    ready: ["bg-emerald-500", "Model ready"],
    down: ["bg-red-500", "The model isn't responding right now"],
  };
  const [dot, label] = styles[status];
  return (
    <span className="-mt-3 inline-flex items-center gap-2 text-xs text-zinc-500" role="status">
      <span className={`h-2 w-2 rounded-full ${dot}`} /> {label}
    </span>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function MatchCard({ match, rank }: { match: Match; rank: number }) {
  const isTop = rank === 0;
  const size = isTop ? "h-52 w-52 sm:h-56 sm:w-56" : "h-36 w-36 sm:h-40 sm:w-40";
  const cardPad = isTop ? "p-6" : "p-4";
  const accent = ACCENT_CLASSES[rank % ACCENT_CLASSES.length];

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.9, rotate: rank % 2 === 0 ? -4 : 4 }}
      animate={{ opacity: 1, y: 0, scale: 1, rotate: isTop ? 0 : rank % 2 === 0 ? -3 : 3 }}
      transition={{ delay: 0.15 + rank * 0.12, type: "spring", stiffness: 200, damping: 20 }}
      whileHover={{ rotate: 0, scale: 1.03 }}
      className={`relative flex flex-col items-center gap-3 rounded-[1.75rem] border-2 border-black/10 ${accent} ${cardPad} ${isTop ? "order-first z-10 sm:order-none" : ""}`}
    >
      {isTop && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-black px-3 py-1 text-xs font-bold text-white">
          ★ Best match
        </span>
      )}

      {/* stacked-photo depth effect - two rotated cards peeking out behind the main photo */}
      <div className={`relative ${size}`}>
        <div className="absolute inset-0 -rotate-6 rounded-2xl border-2 border-black/10 bg-white/90" />
        <div className="absolute inset-0 rotate-3 rounded-2xl border-2 border-black/10 bg-white/90" />
        <div className="relative h-full w-full overflow-hidden rounded-2xl border-2 border-black/10">
          {match.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={match.thumbnail} alt={match.name} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-zinc-200" />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6">
            <div className="truncate text-sm font-bold text-white">{match.name}</div>
            <div className="text-xs font-medium text-white/80">
              {Math.round(match.similarity * 100)}% match strength
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function UserCard({ preview }: { preview: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.9, rotate: 3 }}
      animate={{ opacity: 1, y: 0, scale: 1, rotate: 2 }}
      transition={{ type: "spring", stiffness: 200, damping: 20 }}
      whileHover={{ rotate: 0, scale: 1.03 }}
      className="card-accent-you relative flex flex-col items-center gap-3 rounded-[1.75rem] border-2 border-black/10 p-4"
    >
      <div className="relative h-40 w-40 sm:h-44 sm:w-44">
        <div className="absolute inset-0 rotate-6 rounded-2xl border-2 border-black/10 bg-white/90" />
        <div className="absolute inset-0 -rotate-3 rounded-2xl border-2 border-black/10 bg-white/90" />
        <div className="relative h-full w-full overflow-hidden rounded-2xl border-2 border-black/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Your photo" className="h-full w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6">
            <div className="text-sm font-bold text-white">You</div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function StarAccent({
  className,
  size = 24,
  rotate = 0,
}: {
  className?: string;
  size?: number;
  rotate?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={`star-accent ${className ?? ""}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <path d="M12 0l2.5 8.5L23 12l-8.5 2.5L12 24l-2.5-9.5L1 12l8.5-3.5L12 0z" />
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
