// POST /api/send-test — emails the latest briefing to the team (BRIEFING_REPLY_TO) only, never the
// distribution list. Used to check the Resend setup. Limited to one send per 10 minutes.
// Optional JSON body {"to": ["a@x", ...]} narrows it to part of the team (others are ignored).
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendBriefingEmail, emailSettings } from "../lib/email.mts";

export default async (req: Request) => {
  let only: string[] = [];
  try { const b = await req.json(); if (Array.isArray(b?.to)) only = b.to.map(String); } catch { /* no body: whole team */ }
  const store = getStore({ name: "acc-briefing", consistency: "strong" });
  const last: any = await store.get("lastTestSend", { type: "json" });
  if (last && Date.now() - last.at < 10 * 60_000) return Response.json({ ok: false, error: "A test was sent in the last 10 minutes." }, { status: 429 });

  const briefing: any = await store.get("latest", { type: "json" });
  if (!briefing) return Response.json({ ok: false, error: "No briefing to send yet." }, { status: 404 });
  const s = emailSettings();
  try {
    const result = await sendBriefingEmail(briefing, { audience: "team", subjectPrefix: "[Test] ", only });
    await store.setJSON("lastTestSend", { at: Date.now(), ...result });
    return Response.json({ ok: true, from: s.from, team: s.team, distroCount: s.distro.length, ...result });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e), from: s.from, teamCount: s.team.length, hasKey: !!s.apiKey }, { status: 500 });
  }
};

export const config: Config = { path: "/api/send-test", method: "POST" };
