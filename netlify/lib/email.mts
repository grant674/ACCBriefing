// Email delivery via Resend (https://resend.com). Settings come from Netlify environment variables:
//   RESEND_API_KEY        required — from resend.com → API Keys
//   BRIEFING_FROM         sender, default "Pacheco ACC Briefing <briefing@pachecoaz.com>" (domain must be verified in Resend)
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
    from: env("BRIEFING_FROM") || "Pacheco ACC Briefing <briefing@pachecoaz.com>",
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

function wrap(briefingHtml: string, banner?: string) {
  const top = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6656;margin:0 0 16px;">`
    + `<a href="${SITE_URL}" style="color:#a24f33;">View online or save as PDF</a></p>`;
  const warn = banner
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;background:#fbeceb;border:1px solid #efc4c2;color:#9b2226;padding:10px 12px;margin:0 0 16px;">${esc(banner)}</p>`
    : "";
  const foot = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8574;margin:20px 0 0;">`
    + `You're receiving the ACC Daily Briefing from ${esc(BRAND.name)}. Reply to this email with questions, or to stop receiving it.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:24px 16px;background:#ffffff;">${warn}${top}${briefingHtml}${foot}</body></html>`;
}

export async function sendBriefingEmail(briefing: any, opts: { audience: "full" | "team"; banner?: string; subjectPrefix?: string }) {
  const s = emailSettings();
  if (!s.apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!s.team.length) throw new Error("BRIEFING_REPLY_TO is not set");
  const bcc = opts.audience === "full" ? s.distro.filter((a) => !s.team.includes(a)) : [];
  const subject = `${opts.subjectPrefix || ""}${briefing.subject}`;
  const html = wrap(briefing.html, opts.banner);
  const body: any = { from: s.from, to: s.team, reply_to: s.team, subject, html, text: toText(html) };
  if (bcc.length) body.bcc = bcc;
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${s.apiKey}`,
      "Content-Type": "application/json",
      // Resend dedupes on this key for 24h, so a retried send can't double-deliver.
      "Idempotency-Key": `acc-briefing-${briefing.date}-${opts.audience}-${briefing.generatedAt}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${out?.message || out?.name || "send failed"}`);
  return { id: out.id, to: s.team.length, bcc: bcc.length };
}
