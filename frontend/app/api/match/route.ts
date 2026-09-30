import { NextRequest, NextResponse } from "next/server";

// Server-side proxy to the matching backend (backend/app.py). Keeps the backend URL and its
// shared API key out of the browser. Locally: `uvicorn backend.app:app --port 8787`;
// deployed: the GKE Ingress IP (set BACKEND_URL / BACKEND_API_KEY in Vercel).
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787/match";
const BACKEND_API_KEY = process.env.BACKEND_API_KEY;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.image) {
    return NextResponse.json({ error: "invalid_image" }, { status: 400 });
  }

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BACKEND_API_KEY ? { "X-API-Key": BACKEND_API_KEY } : {}),
      },
      body: JSON.stringify({ image: body.image }),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "backend_unreachable" },
      { status: 502 }
    );
  }
}
