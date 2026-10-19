// Returns the latest (or a specific day's) briefing plus generation status.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const store = getStore({ name: "acc-briefing", consistency: "strong" });
  const date = new URL(req.url).searchParams.get("date");
  const key = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `day/${date}` : "latest";
  const [status, briefing, list] = await Promise.all([
    store.get("status", { type: "json" }),
    store.get(key, { type: "json" }),
    store.list({ prefix: "day/" }),
  ]);
  const dates = list.blobs.map((b) => b.key.slice(4)).sort().reverse().slice(0, 30);
  return Response.json({ status: status || { state: "idle" }, briefing, dates }, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = { path: "/api/briefing", method: "GET" };
