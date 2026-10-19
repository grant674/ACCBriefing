// Scheduled: kicks off the background generator every morning.
// 6:00 AM Arizona = 13:00 UTC (Arizona is UTC-7 all year — no daylight saving shift).
import type { Config } from "@netlify/functions";

export default async () => {
  const base = Netlify.env.get("URL") || "https://acc-briefing.netlify.app";
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "schedule" }),
  });
  console.log(`Daily briefing triggered: HTTP ${res.status}`);
};

export const config: Config = { schedule: "0 13 * * *" };
