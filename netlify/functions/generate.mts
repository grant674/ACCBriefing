// Background function: builds the briefing (can take a few minutes) and saves it to Netlify Blobs.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { generateBriefing } from "../lib/briefing.mts";

const RUN_TIMEOUT_MS = 14 * 60_000; // treat a "running" status older than this as stale
const COOLDOWN_MS = 5 * 60_000; // ignore repeat requests right after a finished run

export default async (req: Request) => {
  const store = getStore({ name: "acc-briefing", consistency: "strong" });
  const now = Date.now();
  let trigger = "manual";
  try { trigger = (await req.json())?.trigger || trigger; } catch { /* no body */ }

  const status: any = await store.get("status", { type: "json" });
  if (status?.state === "running" && now - status.startedAt < RUN_TIMEOUT_MS) return;
  if (status?.state === "done" && trigger !== "schedule" && now - (status.finishedAt || 0) < COOLDOWN_MS) return;

  await store.setJSON("status", { state: "running", startedAt: now, trigger });
  try {
    const briefing = await generateBriefing(now);
    await store.setJSON(`day/${briefing.date}`, briefing);
    await store.setJSON("latest", briefing);
    await store.setJSON("status", { state: "done", startedAt: now, finishedAt: Date.now(), trigger });
  } catch (e: any) {
    console.error("Briefing generation failed:", e);
    // Record the error instead of throwing, so Netlify doesn't auto-retry (each retry costs AI credits).
    await store.setJSON("status", { state: "error", startedAt: now, finishedAt: Date.now(), trigger, error: String(e?.message || e) });
  }
};

export const config: Config = { background: true, path: "/api/generate", method: "POST" };
