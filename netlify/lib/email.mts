// Email delivery via Resend (https://resend.com). Settings come from Netlify environment variables:
//   RESEND_API_KEY        required — from resend.com → API Keys
//   BRIEFING_FROM         sender, default "Pacheco ACC Briefing <briefing@pachecoventuresaz.com>" (domain must be verified in Resend)
//   BRIEFING_REPLY_TO     comma-separated team addresses; replies go here and they're on the To: line of every send
//   BRIEFING_RECIPIENTS   optional extra distribution addresses (the main list is edited in the Compose panel
//                         and stored in Netlify Blobs under "distro"). Each recipient gets their own copy.
import { BRAND } from "./briefing.mts";

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const BATCH_SIZE = 100; // Resend batch limit
const SITE_URL = (process.env.URL || "https://accbriefing.netlify.app").replace(/\/+$/, "");

const EMAIL_RE = /^[^@\s<>(),;:"]+@[^@\s<>(),;:"]+\.[a-z]{2,}$/i;
const list = (v: string | undefined) =>
  (v || "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s));

// Parse pasted text ("a@x.com, b@y.org\nName <c@z.com>") into valid, lowercased, de-duplicated
// addresses, plus whatever couldn't be read as an address.
export function parseEmails(text: string) {
  const valid: string[] = [], invalid: string[] = [];
  for (const raw of String(text || "").split(/[,;\n\r\t ]+/)) {
    const t = raw.trim().replace(/^<|>$/g, "").replace(/^mailto:/i, "");
    if (!t) continue;
    if (EMAIL_RE.test(t)) { const e = t.toLowerCase(); if (!valid.includes(e)) valid.push(e); }
    else if (t.includes("@")) invalid.push(raw.trim());
  }
  return { valid, invalid };
}

// The distribution list: the site-managed list in Blobs plus any BRIEFING_RECIPIENTS, minus the team.
export async function loadDistro(store: any): Promise<string[]> {
  const saved: any = await store.get("distro", { type: "json" });
  const s = emailSettings();
  const team = s.team.map((a) => a.toLowerCase());
  const all = [...(saved?.emails || []), ...s.distro].map((a: string) => a.toLowerCase());
  return [...new Set(all)].filter((a) => !team.includes(a));
}

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

async function resend(url: string, apiKey: string, payload: unknown, idemKey: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${out?.message || out?.name || "send failed"}`);
  return out;
}

export async function sendBriefingEmail(briefing: any, opts: { audience: "full" | "team"; banner?: string; subjectPrefix?: string; only?: string[]; note?: string; manual?: boolean; distro?: string[] }) {
  const s = emailSettings();
  if (!s.apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!s.team.length) throw new Error("BRIEFING_REPLY_TO is not set");
  const subject = `${opts.subjectPrefix || ""}${briefing.subject}`;
  const html = wrap(briefing.html, opts.banner, opts.note);
  const text = toText(html);
  // `only` narrows a team send to a subset of the team (used for tests); replies then go to that subset too.
  const team = opts.only?.length ? s.team.filter((a) => opts.only!.map((x) => x.toLowerCase()).includes(a.toLowerCase())) : s.team;
  if (!team.length) throw new Error("None of the requested test recipients are on BRIEFING_REPLY_TO");
  const teamLc = s.team.map((a) => a.toLowerCase());
  const distro = opts.audience === "full" ? [...new Set((opts.distro ?? s.distro).map((a) => a.toLowerCase()))].filter((a) => !teamLc.includes(a)) : [];
  // Resend dedupes on these keys for 24h, so a retried send can't double-deliver. Deliberate sends get a unique key.
  const base = `acc-briefing-${briefing.date}-${opts.audience}-${briefing.generatedAt}${opts.subjectPrefix === "[Test] " || opts.manual ? "-" + Date.now() : ""}`;

  // 1) The team's copy: all of them on To:, replies go to all of them.
  const out = await resend(RESEND_URL, s.apiKey, { from: s.from, to: team, reply_to: team, subject, html, text }, `${base}-team-${team.join("+")}`);

  // 2) Each distribution-list recipient gets their own copy (private, and no 50-recipient limit), in batches.
  let delivered = 0;
  const failures: string[] = [];
  for (let i = 0; i < distro.length; i += BATCH_SIZE) {
    const chunk = distro.slice(i, i + BATCH_SIZE);
    try {
      await resend(RESEND_BATCH_URL, s.apiKey, chunk.map((to) => ({ from: s.from, to: [to], reply_to: s.team, subject, html, text })), `${base}-distro-${i}`);
      delivered += chunk.length;
    } catch (e: any) {
      failures.push(`batch ${i / BATCH_SIZE + 1} (${chunk.length}): ${e?.message || e}`);
    }
  }
  if (failures.length && !delivered) throw new Error(`Team copy sent, but the distribution list failed: ${failures.join("; ")}`);
  return { id: out.id, to: team, distro: delivered, ...(failures.length ? { failures } : {}) };
}
