import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL, backendHeaders } from "../lib";

// Server-side proxy to the matching backend (backend/app.py). Keeps the backend URL and its
// shared API key out of the browser.
// First request after the free-tier backend wakes can be slow; allow up to 60 s on Vercel.
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.image) {
    return NextResponse.json({ error: "invalid_image" }, { status: 400 });
  }

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...backendHeaders() },
      body: JSON.stringify({ image: body.image }),
      signal: AbortSignal.timeout(60000),
    });
    // a sleeping / booting Hugging Face Space answers with an HTML page or a 502-504
    const isJson = res.headers.get("content-type")?.includes("application/json");
    if (!isJson || [502, 503, 504].includes(res.status)) {
      return NextResponse.json({ error: "backend_waking" }, { status: 503 });
    }
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend_unreachable" }, { status: 502 });
  }
}
