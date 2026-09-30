import { NextResponse } from "next/server";
import { BACKEND_HEALTH_URL, backendHeaders } from "../lib";

// Called as soon as the page opens, so a sleeping free-tier backend starts waking up while the
// user is still choosing a photo. Must run per request, never prerendered.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(BACKEND_HEALTH_URL, {
      headers: backendHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
    return NextResponse.json({ ready: res.ok && body?.ready === true });
  } catch {
    // timeout / connection refused while the Space boots
    return NextResponse.json({ ready: false });
  }
}
