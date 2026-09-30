"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

const CAMERA_ERRORS: Record<string, string> = {
  NotAllowedError: "Camera access was blocked. Allow it in your browser's site settings, or upload a photo instead.",
  NotFoundError: "No camera was found on this device.",
  NotReadableError: "The camera is being used by another app.",
  OverconstrainedError: "This camera doesn't support the requested mode.",
};

// getUserMedia only exists in secure contexts (https or localhost)
export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Live selfie capture. The stream stays on-device: frames are only drawn to a canvas when the
 * user presses "Take photo", and the camera is released as soon as the dialog closes.
 */
export default function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((e: DOMException) => setError(CAMERA_ERRORS[e.name] ?? "Couldn't start the camera."));

    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onClose]);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    // mirror like the preview, so the photo looks like what the user just saw
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => blob && onCapture(new File([blob], "selfie.jpg", { type: "image/jpeg" })),
      "image/jpeg",
      0.92
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Take a selfie"
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        className="solid-card flex w-full max-w-md flex-col items-center gap-4 rounded-[2rem] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-extrabold tracking-tight text-zinc-900">Take a selfie</h2>

        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[1.5rem] border-2 border-black/10 bg-zinc-900">
          {error ? (
            <p className="flex h-full items-center justify-center px-6 text-center text-sm text-white/90">{error}</p>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={() => setReady(true)}
                className="h-full w-full -scale-x-100 object-cover"
              />
              {/* face guide */}
              <div className="pointer-events-none absolute left-1/2 top-1/2 h-[70%] w-[45%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-dashed border-white/60" />
            </>
          )}
        </div>

        <p className="text-center text-xs text-zinc-500">
          Face the camera in good light. Nothing is sent until you press &quot;Find my doppelganger&quot;.
        </p>

        <div className="flex w-full gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-full border-2 border-black/10 bg-white px-6 py-3 font-bold text-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={capture}
            disabled={!ready || !!error}
            className="tactile-btn flex-1 rounded-full bg-[#ff5a1f] px-6 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Take photo
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
