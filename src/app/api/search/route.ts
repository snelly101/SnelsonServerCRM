import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { globalSearch } from "@/services/search";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const hits = await globalSearch(q);
  return NextResponse.json({ hits });
}
