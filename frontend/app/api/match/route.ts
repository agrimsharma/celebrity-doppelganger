import { NextRequest, NextResponse } from "next/server";

// Proxies to the local real-matching server (scripts/local_api_server.py) - runs the actual
// validated pipeline (277,752 real embeddings) instead of the earlier hardcoded mock. Swap this
// for the real Lambda Function URL once Milestone 2 (AWS backend) is deployed.
const BACKEND_URL = "http://127.0.0.1:8787/match";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.image) {
    return NextResponse.json({ error: "invalid_image" }, { status: 400 });
  }

  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
