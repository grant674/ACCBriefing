// /api/compose — the Compose panel (site URL + #send). Every action needs the passcode in
// BRIEFING_ADMIN_CODE (Netlify environment variable), sent as the "x-admin-code" header.
//   GET                      → saved note, today's send status, team, distribution count
//   POST {action:"save", note}           → save a note for the next noon email
//   POST {action:"clear"}                → remove the saved note
//   POST {action:"send", note, audience} → email the latest briefing now; audience "team" | "full"
//   POST {action:"distro-add", emails}   → add pasted addresses to the distribution list
//   POST {action:"distro-remove", email} → remove one address
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";
import { azDate } from "../lib/briefing.mts";
import { sendBriefingEmail, emailSettings, loadDistro, parseEmails } from "../lib/email.mts";

const env = (k: string) => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];
const MAX_NOTE = 4000;
const MAX_DISTRO = 1000;

function codeOk(given: string | null) {
  const want = env("BRIEFING_ADMIN_CODE") || "";
  if (!want || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req: Request) => {
  if (!env("BRIEFING_ADMIN_CODE")) return Response.json({ ok: false, error: "BRIEFING_ADMIN_CODE is not set in Netlify." }, { status: 503 });
  if (!codeOk(req.headers.get("x-admin-code"))) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    return Response.json({ ok: false, error: "Wrong passcode." }, { status: 401 });
  }
  const store = getStore({ name: "acc-briefing", consistency: "strong" });
  const s = emailSettings();
  const today = azDate(Date.now());

  if (req.method === "GET") {
    const [note, sent, latest, saved, distro] = await Promise.all([
      store.get("note/next", { type: "json" }),
      store.get(`sent/${today}`, { type: "json" }),
      store.get("latest", { type: "json" }),
      store.get("distro", { type: "json" }),
      loadDistro(store),
    ]);
    return Response.json({
      ok: true, note, sentToday: sent, from: s.from, team: s.team, hasKey: !!s.apiKey,
      distro: ((saved as any)?.emails || []), distroCount: distro.length, envDistro: s.distro,
      latest: latest ? { date: (latest as any).date, subject: (latest as any).subject, analysisFailed: !!(latest as any).errors?.analysis } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const note = String(body.note || "").slice(0, MAX_NOTE);

  if (body.action === "save") {
    if (!note.trim()) return Response.json({ ok: false, error: "The note is empty." }, { status: 400 });
    await store.setJSON("note/next", { text: note, savedAt: Date.now() });
    return Response.json({ ok: true, saved: true });
  }
  if (body.action === "clear") {
    await store.delete("note/next");
    return Response.json({ ok: true, cleared: true });
  }
  if (body.action === "distro-add" || body.action === "distro-remove") {
    const saved: any = (await store.get("distro", { type: "json" })) || { emails: [] };
    const team = s.team.map((a) => a.toLowerCase());
    let emails: string[] = saved.emails || [];
    let added: string[] = [], skipped: string[] = [], invalid: string[] = [];
    if (body.action === "distro-add") {
      const parsed = parseEmails(String(body.emails || ""));
      invalid = parsed.invalid;
      for (const e of parsed.valid) {
        if (team.includes(e) || emails.includes(e)) skipped.push(e); else { emails.push(e); added.push(e); }
      }
      if (emails.length > MAX_DISTRO) return Response.json({ ok: false, error: `The list is limited to ${MAX_DISTRO} addresses.` }, { status: 400 });
    } else {
      const target = String(body.email || "").toLowerCase();
      emails = emails.filter((e) => e !== target);
    }
    emails.sort();
    await store.setJSON("distro", { emails, updatedAt: Date.now() });
    return Response.json({ ok: true, distro: emails, added, skipped, invalid });
  }

  if (body.action === "send") {
    const audience = body.audience === "full" ? "full" : "team";
    const briefing: any = await store.get("latest", { type: "json" });
    if (!briefing) return Response.json({ ok: false, error: "No briefing to send yet." }, { status: 404 });
    if (audience === "full" && briefing.errors?.analysis)
      return Response.json({ ok: false, error: "This briefing's summaries failed. Regenerate it before sending to everyone." }, { status: 409 });
    try {
      const result = await sendBriefingEmail(briefing, {
        audience, note, manual: true, subjectPrefix: audience === "team" ? "[Preview] " : "",
        distro: audience === "full" ? await loadDistro(store) : [],
      });
      if (audience === "full") {
        // Counts as that day's send, so the noon job won't send the same briefing again.
        await store.setJSON(`sent/${briefing.date}`, { audience: "full", manual: true, note: !!note.trim(), ...result, at: Date.now() });
        if (note.trim()) await store.delete("note/next");
      }
      return Response.json({ ok: true, audience, ...result });
    } catch (e: any) {
      return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }
  }
  return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
};

export const config: Config = { path: "/api/compose", method: ["GET", "POST"] };
