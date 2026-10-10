"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type Engine from "./engine";
import type { FrameRect } from "./engine";

export type { FrameRect };
export type StageHandle = {
  startSearch: () => void;
  showResults: (thumbnails: (string | null)[], onArrived: () => void) => void;
  back: (onDone?: () => void) => void;
};

/**
 * The full-screen WebGL canvas behind the UI. three.js and the head data load after the page is
 * interactive (dynamic import), so the upload controls never wait for the 3D. Reports `false` to
 * onSupport when WebGL isn't available - the page then falls back to plain HTML results.
 */
export default function Stage({
  ref,
  onSupport,
  onLayout,
}: {
  ref?: Ref<StageHandle>;
  onSupport: (supported: boolean) => void;
  onLayout: (rects: FrameRect[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  // calls that arrive before the engine has loaded run as soon as it's ready
  const pending = useRef<((e: Engine) => void)[]>([]);
  const callbacks = useRef({ onSupport, onLayout });
  useEffect(() => {
    callbacks.current = { onSupport, onLayout };
  }, [onSupport, onLayout]);

  const withEngine = (fn: (e: Engine) => void) => {
    if (engineRef.current) fn(engineRef.current);
    else pending.current.push(fn);
  };

  useImperativeHandle(ref, () => ({
    startSearch: () => withEngine((e) => e.startSearch()),
    showResults: (thumbs, onArrived) => withEngine((e) => e.showResults(thumbs, onArrived)),
    back: (onDone) => {
      if (engineRef.current) engineRef.current.back(onDone);
      else onDone?.();
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) {
      callbacks.current.onSupport(false);
      return;
    }
    let engine: Engine | null = null;
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lowPower = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;

    const onMove = (e: PointerEvent) =>
      engine?.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    const onResize = () => engine?.resize();

    (async () => {
      try {
        const { default: EngineClass } = await import("./engine");
        if (cancelled) return;
        engine = new EngineClass(canvas, { lowPower, reducedMotion });
        engine.setLayoutListener((rects) => callbacks.current.onLayout(rects));
        await engine.load();
        if (cancelled) {
          engine.dispose();
          return;
        }
        engine.start();
        engineRef.current = engine;
        pending.current.splice(0).forEach((fn) => fn(engine!));
        canvas.dataset.ready = "true";
        callbacks.current.onSupport(true);
      } catch {
        callbacks.current.onSupport(false);
      }
    })();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 h-full w-full opacity-0 transition-opacity duration-[1800ms] data-[ready=true]:opacity-100"
    />
  );
}
