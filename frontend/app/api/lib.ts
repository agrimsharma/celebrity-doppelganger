// Shared config for the server-side proxy routes. Locally the backend is
// `uvicorn backend.app:app --port 8787`; deployed it is the Hugging Face Space (or the cluster).
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787/match";
export const BACKEND_HEALTH_URL =
  process.env.BACKEND_HEALTH_URL ?? BACKEND_URL.replace(/\/match$/, "/readyz");

export function backendHeaders(): Record<string, string> {
  const key = process.env.BACKEND_API_KEY;
  return key ? { "X-API-Key": key } : {};
}
