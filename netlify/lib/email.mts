// Email delivery via Resend (https://resend.com). Settings come from Netlify environment variables:
//   RESEND_API_KEY        required — from resend.com → API Keys
//   BRIEFING_FROM         sender, default "Pacheco ACC Briefing <briefing@pachecoventuresaz.com>" (domain must be verified in Resend)
//   BRIEFING_REPLY_TO     comma-separated team addresses; replies go here and they're on the To: line of every send
//   BRIEFING_RECIPIENTS   comma-separated distribution list (Bcc'd). If empty, only the team receives it.
import { BRAND } from "./briefing.mts";

const RESEND_URL = "https://api.resend.com/emails";
const SITE_URL = (process.env.URL || "https://accbriefing.netlify.app").replace(/\/+$/, "");

const list = (v: string | undefined) =>
  (v || "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));

export function emailSettings() {
  const env = (k: string) => (globalThis as any).Netlify?.env?.get(k) ?? process.env[k];
  return {
    apiKey: env("RESEND_API_KEY") || "",
    from: env("BRIEFING_FROM") || "Pacheco ACC Briefing <briefing@pachecoventuresaz.com>",
    team: list(env("BRIEFING_REPLY_TO")),
    distro: list(env("BRIEFING_RECIPIENTS")),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toText = (html: string) =>
  html.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, "")} (${href})`)
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

// The editor's note: plain text, line breaks kept, shown in a box above the briefing.
export function noteHtml(note?: string) {
  const t = (note || "").trim();
  if (!t) return "";
  const body = t.split(/\n{2,}/).map((para) => `<p style="margin:0 0 8px;">${esc(para).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#302c1e;background:#f7f2ec;border-left:4px solid #c96c4d;padding:12px 16px 6px;margin:0 0 20px;max-width:720px;">`
    + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#a24f33;margin:0 0 8px;font-weight:bold;">Note from ${esc(BRAND.name)}</p>${body}</div>`;
}

function wrap(briefingHtml: string, banner?: string, note?: string) {
  const top = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6656;margin:0 0 16px;">`
    + `<a href="${SITE_URL}" style="color:#a24f33;">View online or save as PDF</a></p>`;
  const warn = banner
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;background:#fbeceb;border:1px solid #efc4c2;color:#9b2226;padding:10px 12px;margin:0 0 16px;">${esc(banner)}</p>`
    : "";
  const foot = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8574;margin:20px 0 0;">`
    + `You're receiving the ACC Daily Briefing from ${esc(BRAND.name)}. Reply to this email with questions, or to stop receiving it.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:24px 16px;background:#ffffff;">${warn}${top}${noteHtml(note)}${briefingHtml}${foot}</body></html>`;
}

export async function sendBriefingEmail(briefing: any, opts: { audience: "full" | "team"; banner?: string; subjectPrefix?: string; only?: string[]; note?: string; manual?: boolean }) {
  const s = emailSettings();
  if (!s.apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!s.team.length) throw new Error("BRIEFING_REPLY_TO is not set");
  const bcc = opts.audience === "full" ? s.distro.filter((a) => !s.team.includes(a)) : [];
  const subject = `${opts.subjectPrefix || ""}${briefing.subject}`;
  const html = wrap(briefing.html, opts.banner, opts.note);
  // `only` narrows a team send to a subset of the team (used for tests); replies then go to that subset too.
  const team = opts.only?.length ? s.team.filter((a) => opts.only!.map((x) => x.toLowerCase()).includes(a.toLowerCase())) : s.team;
  if (!team.length) throw new Error("None of the requested test recipients are on BRIEFING_REPLY_TO");
  const body: any = { from: s.from, to: team, reply_to: team, subject, html, text: toText(html) };
  if (bcc.length) body.bcc = bcc;
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.apiKey}`,
      "Content-Type": "application/json",
      // Resend dedupes on this key for 24h, so a retried send can't double-deliver.
      "Idempotency-Key": `acc-briefing-${briefing.date}-${opts.audience}-${briefing.generatedAt}-${team.join("+")}${opts.subjectPrefix === "[Test] " || opts.manual ? "-" + Date.now() : ""}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${out?.message || out?.name || "send failed"}`);
  return { id: out.id, to: team, bcc: bcc.length };
}
