// Scheduled: emails the morning briefing at 6:30 AM Arizona (13:30 UTC; Arizona has no DST),
// 30 minutes after the 6:00 build. Scheduled functions can't be called by URL, so nobody can
// trigger a send to the distribution list from outside.
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { azDate } from "../lib/briefing.mts";
import { sendBriefingEmail } from "../lib/email.mts";

export default async () => {
  const store = getStore({ name: "acc-briefing", consistency: "strong" });
  const today = azDate(Date.now());
  const sentKey = `sent/${today}`;
  if (await store.get(sentKey)) { console.log(`Already sent for ${today}`); return; }

  const briefing: any = await store.get("latest", { type: "json" });
  const status: any = await store.get("status", { type: "json" });
  // A note saved from the Compose panel rides on the next morning's email, then is cleared.
  const saved: any = await store.get("note/next", { type: "json" });
  const note: string = saved?.text || "";
  let result: any;
  try {
    if (!briefing || briefing.date !== today) {
      // Today's build didn't finish: tell the team instead of sending yesterday's briefing to everyone.
      const fallback = briefing || { date: today, generatedAt: Date.now(), subject: "ACC Daily Briefing", html: "<p>No briefing available.</p>" };
      result = await sendBriefingEmail(fallback, {
        audience: "team", subjectPrefix: "[Not sent — needs attention] ",
        banner: `Today's briefing (${today}) didn't finish building${status?.error ? `: ${status.error}` : ""}. It was NOT sent to the distribution list. The most recent briefing is below; regenerate it on the site and forward it if needed.`,
      });
      await store.setJSON(sentKey, { audience: "team", reason: "no briefing for today", ...result, at: Date.now() });
    } else if (briefing.errors?.analysis) {
      // Summaries failed: hold it for the team rather than sending raw records to clients.
      result = await sendBriefingEmail(briefing, {
        audience: "team", subjectPrefix: "[Held for review] ", note,
        banner: "The plain-language summaries failed this morning, so this briefing was NOT sent to the distribution list. Regenerate it on the site and forward it if it looks right.",
      });
      await store.setJSON(sentKey, { audience: "team", reason: "analysis failed", ...result, at: Date.now() });
    } else {
      result = await sendBriefingEmail(briefing, { audience: "full", note });
      await store.setJSON(sentKey, { audience: "full", note: !!note, ...result, at: Date.now() });
      if (note) await store.delete("note/next");
    }
    console.log(`Briefing email sent for ${today}:`, JSON.stringify(result));
  } catch (e: any) {
    console.error("Briefing email failed:", e);
    await store.setJSON("lastSendError", { date: today, at: Date.now(), error: String(e?.message || e) });
  }
};

export const config: Config = { schedule: "30 13 * * *" };
