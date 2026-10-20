// Core ACC briefing engine: pull ACC sources directly, summarize with Claude, render email-safe HTML.
import Anthropic from "@anthropic-ai/sdk";

const EFILING_API = "https://efiling.azcc.gov/api";
const EDOCKET_WEB = "https://edocket.azcc.gov";
const AZCC = "https://azcc.gov";
const AZ_OFFSET_MS = -7 * 3600_000; // Arizona stays on MST (UTC-7) all year
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const UA = "Mozilla/5.0 (compatible; ACC-Daily-Briefing/2.0)";
const MODELS = [process.env.BRIEFING_MODEL, "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-sonnet-4-5"].filter(Boolean) as string[];

// Branding. The logo is served from the site itself (public/pacheco-logo.png); an absolute URL
// keeps it visible when the briefing is pasted into Gmail.
const SITE_URL = (process.env.URL || "https://accbriefing.netlify.app").replace(/\/+$/, "");
export const BRAND = {
  name: "Pacheco",
  logoUrl: `${SITE_URL}/pacheco-logo.png`,
};

export const SOURCES = {
  recentDockets: `${EDOCKET_WEB}/recent-dockets`,
  todaysEvents: `${AZCC}/news/today's-events`,
  calendar: `${EDOCKET_WEB}/calendar`,
  newsReleases: `${AZCC}/news/home`,
};

// ── Time helpers (Arizona) ─────────────────────────────────
export const azDate = (ms: number) => new Date(ms + AZ_OFFSET_MS).toISOString().slice(0, 10);
const azStartOfDay = (ms: number) => Date.parse(`${azDate(ms)}T00:00:00-07:00`);
const fmt = (ms: number, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", ...o }).format(new Date(ms));
export const fmtLongDay = (ms: number) => fmt(ms, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtDayHeading = (ms: number) => fmt(ms, { weekday: "long", month: "long", day: "numeric" });
const fmtShort = (ms: number) => fmt(ms, { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ms: number) => fmt(ms, { hour: "numeric", minute: "2-digit" });
const parseAz = (s: string) => Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}-07:00`);
const fmtYmd = (ymd: string) => fmtShort(Date.parse(`${ymd}T12:00:00-07:00`));

// ── Fetch helpers ──────────────────────────────────────────
async function getJSON(url: string, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}
async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.text();
}
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try { await fn(item); } catch (e) { console.warn("item failed:", (e as Error).message); }
      }
    }),
  );
}
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "—").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const htmlToText = (html: string) =>
  decode(
    html.replace(/<(script|style|noscript|head|svg|nav|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

// ── Source 1: Recent docket activity (eDocket feed) ────────
export async function collectDockets(now: number) {
  const cutoff = now - 48 * HOUR;
  const cutoffDay = azDate(cutoff);
  const rows: any[] = await getJSON(`${EFILING_API}/eDocket/GetRecentDockets`);
  const byId = new Map<number, any>();
  for (const r of rows) {
    const t = parseAz(r.modifiedOnDateTime);
    if (!(t >= cutoff)) continue;
    let d = byId.get(r.details);
    if (!d) {
      d = { docketId: r.details, docketNumber: clean(r.docketNumber), company: clean(r.companyName), title: clean(r.description),
        activityTypes: new Set<string>(), lastActivity: 0, documents: [], newDocumentCount: 0 };
      byId.set(r.details, d);
    }
    d.activityTypes.add(clean(r.activityType));
    d.lastActivity = Math.max(d.lastActivity, t);
  }
  const dockets = [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);

  await mapLimit(dockets, 6, async (d) => {
    const det = await getJSON(`${EFILING_API}/edocket/docket/${d.docketId}`, 45_000);
    d.docketType = clean(det.docketType?.value);
    d.caseType = clean(det.caseType?.descr);
    d.status = clean(det.docketStatus?.value);
    const docs = (det.documents || [])
      .filter((x: any) => typeof x.filedDate === "string" && x.filedDate.slice(0, 10) >= cutoffDay)
      .sort((a: any, b: any) => String(b.filedDate).localeCompare(String(a.filedDate)) || b.documentID - a.documentID);
    d.newDocumentCount = docs.length;
    d.documents = docs.slice(0, 12).map((x: any) => ({
      type: clean(x.description || x.documentDesc) || "Document",
      filedBy: clean(x.filedBy),
      filedFor: clean(x.filedFor),
      date: x.filedDate.slice(0, 10),
      url: `${EDOCKET_WEB}/search/document-search/item-detail/${x.documentID}`,
    }));
  });

  return dockets.map((d) => ({ ...d, activityTypes: [...d.activityTypes], url: `${EDOCKET_WEB}/search/docket-search/item-detail/${d.docketId}` }));
}

// ── Source 2: Events & hearings, today through +7 days ─────
export async function collectEvents(now: number) {
  const data = await getJSON(`${EFILING_API}/eDocket/GetDates/${azDate(now)}/${azDate(now + 7 * DAY)}/-1`);
  const from = azStartOfDay(now);
  const to = azStartOfDay(now + 8 * DAY);
  const byId = new Map<number, any>();
  for (const r of data.result || []) {
    let e = byId.get(r.EventID);
    if (!e) {
      const notes = (r.Notes || []).map(clean).filter(Boolean);
      e = { eventId: r.EventID, type: clean(r.EventType), subject: clean(r.Subject), start: Number(r.Start), end: Number(r.End),
        location: [clean(r.Location), clean(r.City)].filter(Boolean).join(", "), dialIn: notes.join(" "), hasNotice: !!clean(r.NoticeFileName),
        dockets: [] as any[], companies: [] as string[] };
      byId.set(r.EventID, e);
    }
    const num = clean(r.DocketNumber);
    if (num && !e.dockets.some((x: any) => x.number === num))
      e.dockets.push({ number: num, url: r.DocketID ? `${EDOCKET_WEB}/search/docket-search/item-detail/${r.DocketID}` : SOURCES.calendar });
    const co = clean(r.CompanyName);
    if (co && !e.companies.includes(co)) e.companies.push(co);
  }
  return [...byId.values()].filter((e) => e.start >= from && e.start < to).sort((a, b) => a.start - b.start);
}

// ── Source 3: ACC news releases ────────────────────────────
export async function collectReleases(now: number) {
  const cutoffDay = azDate(now - 48 * HOUR);
  const html = await getText(SOURCES.newsReleases);
  const found = new Map<string, { url: string; date: string; title: string }>();
  const re = /<a\b[^>]*href="((?:https?:\/\/(?:www\.)?azcc\.gov)?\/news\/home\/(\d{4})\/(\d{2})\/(\d{2})\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const url = (m[1].startsWith("http") ? m[1] : AZCC + m[1]).replace(/^http:/, "https:");
    // Strip screen-reader prefixes like "Read Article:" that azcc.gov puts inside the link text
    const title = clean(decode(m[5].replace(/<[^>]+>/g, " "))).replace(/^read (?:article|more)\s*:\s*/i, "");
    const prev = found.get(url);
    if (!prev || (title.length > prev.title.length && !/^read (?:more|article)$/i.test(title)))
      found.set(url, { url, date: `${m[2]}-${m[3]}-${m[4]}`, title: /^read (?:more|article)$/i.test(title) ? prev?.title || "" : title });
  }
  const all = [...found.values()].filter((r) => r.title).sort((a, b) => b.date.localeCompare(a.date));
  const recent = all.filter((r) => r.date >= cutoffDay);
  await mapLimit(recent, 4, async (r: any) => {
    const text = htmlToText(await getText(r.url));
    const at = text.indexOf(r.title.slice(0, 40));
    r.excerpt = text.slice(at > -1 ? at : 0, (at > -1 ? at : 0) + 6000);
  });
  return { recent, latest: all[0] || null };
}

// ── Claude helpers ─────────────────────────────────────────
async function createMessage(client: Anthropic, params: any) {
  let lastErr: unknown;
  for (const model of MODELS) {
    try {
      return await client.messages.create({ ...params, model });
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (e?.status === 404 || /model/i.test(msg)) { console.warn(`Model ${model} unavailable, trying next:`, msg); continue; }
      throw e;
    }
  }
  throw lastErr;
}
const textOf = (msg: any) => msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
function parseJSONFrom(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("No JSON found in model output");
  return JSON.parse(body.slice(start, end + 1));
}
const normUrl = (u: string) => u.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

// ── Local news via web search (links verified against actual search results) ──
export async function searchNews(client: Anthropic, now: number) {
  const cutoffDay = azDate(now - 48 * HOUR);
  const msg = await createMessage(client, {
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6,
      user_location: { type: "approximate", city: "Phoenix", region: "Arizona", country: "US", timezone: "America/Phoenix" } }],
    messages: [{
      role: "user",
      content: `Today is ${fmtLongDay(now)} (Arizona time). Search the web for news articles published on or after ${cutoffDay} about the Arizona Corporation Commission (ACC): its commissioners and votes, utility rate cases and filings (APS, TEP, UNS, Southwest Gas, water utilities, co-ops), power plant and line siting, securities enforcement, or the corporations division. Favor Arizona outlets such as AZPM, KJZZ, Arizona Republic, Arizona Capitol Times, Arizona Mirror, Axios Phoenix, Cronkite News, and KAWC. Run several searches.

Return ONLY a JSON array (no prose) of up to 8 articles, each:
{"title": "...", "publication": "...", "date": "YYYY-MM-DD", "url": "...", "summary": "2-3 plain-language sentences: what happened, who is involved, and why it matters to people who follow the ACC"}
Rules: copy each url exactly as it appears in your search results. Include only articles you can date on or after ${cutoffDay}. Skip anything that is not substantially about the ACC. If nothing qualifies, return [].`,
    }],
  });
  const seen = new Map<string, any>();
  for (const b of msg.content as any[])
    if (b.type === "web_search_tool_result" && Array.isArray(b.content))
      for (const r of b.content) if (r?.url) seen.set(normUrl(r.url), r);
  const debug: any = {
    searches: (msg.content as any[]).filter((b) => b.type === "server_tool_use").length,
    searchErrors: (msg.content as any[]).filter((b) => b.type === "web_search_tool_result" && !Array.isArray(b.content)).map((b) => b.content?.error_code || "error"),
    resultsSeen: seen.size,
    proposed: 0,
    dropped: [] as any[],
  };
  let items: any[] = [];
  try { items = parseJSONFrom(textOf(msg)); } catch { debug.parseError = textOf(msg).slice(0, 300); items = []; }
  if (!Array.isArray(items)) items = [];
  debug.proposed = items.length;
  const out: any[] = [];
  for (const it of items) {
    const hit = it?.url ? seen.get(normUrl(it.url)) : null;
    const reason = !hit ? "url not in search results"
      : !/^\d{4}-\d{2}-\d{2}$/.test(it.date || "") ? "no date"
      : it.date < cutoffDay ? `older than ${cutoffDay}`
      : !clean(it.summary) ? "no summary"
      : out.some((o) => normUrl(o.url) === normUrl(hit.url)) ? "duplicate" : null;
    if (reason) { debug.dropped.push({ title: clean(it?.title).slice(0, 120), url: it?.url, date: it?.date, reason }); continue; }
    out.push({ title: clean(it.title) || clean(hit.title), publication: clean(it.publication), date: it.date, url: hit.url, summary: clean(it.summary) });
  }
  return { items: out, debug };
}

// ── Plain-language analysis of the collected ACC data ──────
async function analyze(client: Anthropic, now: number, data: { dockets: any[]; events: any[]; releases: any[]; news: any[] }) {
  const payload = {
    today: fmtLongDay(now),
    events: data.events.map((e) => ({ eventId: e.eventId, when: `${fmtShort(e.start)} ${fmtTime(e.start)}`, type: e.type, subject: e.subject,
      dockets: e.dockets.map((d: any) => d.number), companies: e.companies, location: e.location })),
    dockets: data.dockets.map((d) => ({ docketId: d.docketId, docketNumber: d.docketNumber, company: d.company, matter: d.title.slice(0, 600),
      docketType: d.docketType, caseType: d.caseType, status: d.status, activity: d.activityTypes, newDocumentCount: d.newDocumentCount,
      newDocuments: d.documents.map((x: any) => `${x.date}: ${x.type}${x.filedBy ? ` — filed by ${x.filedBy}` : ""}${x.filedFor ? ` for ${x.filedFor}` : ""}`) })),
    newsReleases: data.releases.map((r) => ({ url: r.url, date: r.date, title: r.title, text: r.excerpt })),
    newsHeadlines: data.news.map((n) => `${n.publication}: ${n.title}`),
  };
  const msg = await createMessage(client, {
    max_tokens: 9000,
    system: `You are a senior public affairs analyst who covers the Arizona Corporation Commission (ACC) for an Arizona government relations firm. You turn raw regulatory records into a plain-language morning briefing for readers who know Arizona policy but are not lawyers. Explain what each item means and why it matters (for ratepayers, utilities, developers, investors) instead of restating titles. Briefly define unavoidable jargon (e.g. CEC, fair value, rate case, procedural conference). Use only the facts provided plus general knowledge of how ACC proceedings work; never invent outcomes, votes, numbers, or filing contents. When a record only says a document was filed, describe what that type of filing usually signals at that stage, and say so carefully.`,
    messages: [{
      role: "user",
      content: `Here is the ACC data collected this morning (dockets: activity in the last 48 hours; events: today through the next 7 days; news releases: last 48 hours):

${JSON.stringify(payload)}

Return ONLY JSON in exactly this shape:
{
  "subject": "Email subject line, e.g. 'ACC Daily Briefing — Mon, Oct 19: <the most notable item>'",
  "atAGlance": ["2-4 one-sentence takeaways a busy reader needs most today"],
  "events": [{"eventId": <number>, "summary": "1-2 sentences: what the hearing or meeting is about, who is involved, what is being decided, why it matters"}],
  "dockets": [{"docketId": <number>, "summary": "2-3 sentences: which company, what the case is about, what was just filed or changed, what stage it is at, and what the outcome could mean"}],
  "releases": [{"url": "<url exactly as given>", "summary": "2-3 sentences: action taken, who is affected, practical impact"}]
}
Include a summary for every event and every news release given. For dockets, choose the 12 most significant (rate cases, siting cases, securities actions, rulemakings, and large utilities first) and summarize those; the rest are listed automatically. Return [] for any empty section.`,
    }],
  });
  return parseJSONFrom(textOf(msg));
}

// ── HTML rendering (inline styles so it pastes cleanly into Gmail) ──
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const C = { ink: "#302c1e", muted: "#6b6656", rule: "#e2ddd2", accent: "#a24f33", accentBright: "#c96c4d", link: "#1d4ed8", soft: "#f7f2ec" };
const S = {
  wrap: `font-family:Georgia,'Times New Roman',serif;color:${C.ink};max-width:720px;line-height:1.55;font-size:15px;`,
  h1: `font-size:24px;margin:0 0 4px;font-weight:bold;color:${C.ink};`,
  meta: `font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.muted};margin:0 0 18px;`,
  h2: `font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${C.accent};border-bottom:2px solid ${C.accent};padding-bottom:4px;margin:26px 0 12px;`,
  h3: `font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:${C.muted};margin:14px 0 6px;`,
  item: `margin:0 0 14px;`,
  label: `font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.muted};`,
  a: `color:${C.link};text-decoration:underline;`,
  small: `font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:${C.muted};margin:4px 0 0;`,
  glance: `background:${C.soft};border-left:4px solid ${C.accentBright};padding:10px 14px;margin:0 0 6px;`,
  empty: `font-style:italic;color:${C.muted};margin:0 0 10px;`,
};
const link = (href: string, text: string) => `<a href="${esc(href)}" style="${S.a}">${esc(text)}</a>`;

function renderHtml(now: number, d: any, a: any, notes: string[]) {
  const evSum = new Map((a.events || []).map((x: any) => [Number(x.eventId), clean(x.summary)]));
  const dkSum = new Map((a.dockets || []).map((x: any) => [Number(x.docketId), clean(x.summary)]));
  const rlSum = new Map((a.releases || []).map((x: any) => [normUrl(String(x.url || "")), clean(x.summary)]));
  const cutoff = now - 48 * HOUR;
  const out: string[] = [];
  out.push(`<div style="${S.wrap}">`);
  out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;"><tr>`
    + `<td style="vertical-align:middle;padding:0 14px 0 0;"><img src="${esc(BRAND.logoUrl)}" alt="${esc(BRAND.name)}" height="34" style="height:34px;width:auto;display:block;border:0;"></td>`
    + `<td style="vertical-align:middle;border-left:1px solid ${C.rule};padding:0 0 0 14px;"><p style="${S.h1}">ACC Daily Briefing</p></td>`
    + `</tr></table>`);
  out.push(`<p style="${S.meta}">Arizona Corporation Commission · ${esc(fmtLongDay(now))} · Activity since ${esc(fmtShort(cutoff))} ${esc(fmtTime(cutoff))} · Calendar through ${esc(fmtShort(now + 7 * DAY))}</p>`);

  if ((a.atAGlance || []).length) {
    out.push(`<p class="acc-h2" style="${S.h2}">At a glance</p>`);
    for (const g of a.atAGlance) out.push(`<p class="acc-glance" style="${S.glance}">${esc(g)}</p>`);
  }

  // Events
  out.push(`<p class="acc-h2" style="${S.h2}">Events &amp; hearings — next 7 days</p>`);
  if (!d.events.length) out.push(`<p style="${S.empty}">${d.eventsError ? "The ACC calendar could not be reached this morning." : "No events scheduled."} ${link(SOURCES.calendar, "Open the ACC calendar")}</p>`);
  let day = "";
  for (const e of d.events) {
    const dh = fmtDayHeading(e.start);
    if (dh !== day) { day = dh; out.push(`<p class="acc-h3" style="${S.h3}">${esc(dh)}</p>`); }
    const dockets = e.dockets.map((x: any) => link(x.url, x.number)).join(", ");
    const summary = evSum.get(Number(e.eventId));
    out.push(`<div class="acc-item" style="${S.item}"><strong>${esc(fmtTime(e.start))} — ${esc(e.type)}</strong>${e.companies.length ? `: ${esc(e.companies.join(", "))}` : ""}`
      + (summary ? `<br>${esc(summary)}` : e.subject ? `<br>${esc(e.subject)}` : "")
      + `<p style="${S.small}">${[e.location && esc(e.location), dockets && `Docket ${dockets}`, e.dialIn && `Dial-in: ${esc(e.dialIn)}`].filter(Boolean).join(" · ")}</p></div>`);
  }

  // Dockets
  out.push(`<p class="acc-h2" style="${S.h2}">Docket activity — last 48 hours</p>`);
  if (!d.dockets.length) out.push(`<p style="${S.empty}">${d.docketsError ? "eDocket could not be reached this morning." : "No docket activity in the last 48 hours."} ${link(SOURCES.recentDockets, "Open eDocket")}</p>`);
  const featured = d.dockets.filter((x: any) => dkSum.has(Number(x.docketId)));
  const rest = d.dockets.filter((x: any) => !dkSum.has(Number(x.docketId)));
  const docList = (x: any, max: number) => {
    if (!x.documents.length) return x.activityTypes.length ? `<p style="${S.small}">${esc(x.activityTypes.join(", "))}</p>` : "";
    const items = x.documents.slice(0, max).map((doc: any) =>
      `${link(doc.url, doc.type)}${doc.filedBy ? ` — ${esc(doc.filedBy)}` : ""}${doc.filedFor ? ` for ${esc(doc.filedFor)}` : ""} (${esc(fmtYmd(doc.date))})`);
    const more = x.newDocumentCount > max ? ` · ${link(x.url, `+${x.newDocumentCount - max} more`)}` : "";
    return `<p style="${S.small}">${items.join("<br>")}${more}</p>`;
  };
  for (const x of featured) {
    out.push(`<div class="acc-item" style="${S.item}"><strong>${link(x.url, x.docketNumber)} — ${esc(x.company)}</strong>`
      + `${x.caseType ? ` <span style="${S.label}">(${esc([x.docketType, x.caseType].filter(Boolean).join(" · "))})</span>` : ""}`
      + `<br>${esc(dkSum.get(Number(x.docketId)))}${docList(x, 6)}</div>`);
  }
  if (rest.length) {
    out.push(`<p class="acc-h3" style="${S.h3}">Other docket activity (${rest.length})</p>`);
    for (const x of rest) {
      out.push(`<div class="acc-item" style="margin:0 0 8px;font-size:14px;">${link(x.url, x.docketNumber)} — ${esc(x.company)}`
        + `<span style="${S.label}"> · ${esc(x.title.length > 160 ? x.title.slice(0, 157) + "…" : x.title)}</span>${docList(x, 3)}</div>`);
    }
  }

  // News releases
  out.push(`<p class="acc-h2" style="${S.h2}">ACC news releases — last 48 hours</p>`);
  if (!d.releases.length) {
    out.push(`<p style="${S.empty}">${d.releasesError ? "The ACC news page could not be reached this morning." : "No new releases in the last 48 hours."}`
      + (d.latestRelease ? ` Most recent: ${link(d.latestRelease.url, d.latestRelease.title)} (${esc(fmtYmd(d.latestRelease.date))}).` : "") + `</p>`);
  }
  for (const r of d.releases) {
    out.push(`<div class="acc-item" style="${S.item}"><strong>${link(r.url, r.title)}</strong> <span style="${S.label}">${esc(fmtYmd(r.date))}</span>`
      + `${rlSum.get(normUrl(r.url)) ? `<br>${esc(rlSum.get(normUrl(r.url)))}` : ""}<p style="${S.small}">${link(r.url, "Read full release")}</p></div>`);
  }

  // News
  out.push(`<p class="acc-h2" style="${S.h2}">In the news — last 48 hours</p>`);
  if (!d.news.length) out.push(`<p style="${S.empty}">${d.newsError ? "The news search was unavailable this morning." : "No qualifying ACC news coverage found in the last 48 hours."}</p>`);
  for (const n of d.news) {
    out.push(`<div class="acc-item" style="${S.item}"><strong>${esc(n.publication)}: ${esc(n.title)}</strong> <span style="${S.label}">${esc(fmtYmd(n.date))}</span>`
      + `<br>${esc(n.summary)}<p style="${S.small}">${link(n.url, `Read full article — ${n.publication || "source"}`)}</p></div>`);
  }

  out.push(`<p class="acc-h2" style="${S.h2}">Sources</p><p style="${S.small}">${link(SOURCES.recentDockets, "eDocket: Recent Docket Activity")} · ${link(SOURCES.todaysEvents, "ACC: Today's Events")} · ${link(SOURCES.calendar, "ACC calendar")} · ${link(SOURCES.newsReleases, "ACC News Releases")}</p>`);
  if (notes.length) out.push(`<p style="${S.small}">Notes: ${esc(notes.join(" "))}</p>`);
  out.push(`<p class="acc-brand-note" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.muted};border-top:1px solid ${C.rule};margin:24px 0 0;padding-top:10px;">`
    + `Prepared by <strong style="color:${C.ink};">${esc(BRAND.name)}</strong> · Generated ${esc(fmtLongDay(now))} at ${esc(fmtTime(now))} Arizona time from Arizona Corporation Commission public records. `
    + `Summaries are AI-assisted; confirm details in the linked filings.</p>`);
  out.push(`</div>`);
  return out.join("\n");
}

// ── Orchestration ──────────────────────────────────────────
export async function generateBriefing(now = Date.now()) {
  const client = new Anthropic(); // Netlify AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  const notes: string[] = [];
  const [dk, ev, rl, nw] = await Promise.allSettled([collectDockets(now), collectEvents(now), collectReleases(now), searchNews(client, now)]);
  const err = (r: PromiseSettledResult<any>, label: string) => {
    if (r.status === "rejected") { console.error(`${label} failed:`, r.reason); return String((r.reason as Error)?.message || r.reason); }
    return null;
  };
  const d: any = {
    dockets: dk.status === "fulfilled" ? dk.value : [], docketsError: err(dk, "dockets"),
    events: ev.status === "fulfilled" ? ev.value : [], eventsError: err(ev, "events"),
    releases: rl.status === "fulfilled" ? rl.value.recent : [], latestRelease: rl.status === "fulfilled" ? rl.value.latest : null, releasesError: err(rl, "releases"),
    news: nw.status === "fulfilled" ? nw.value.items : [], newsDebug: nw.status === "fulfilled" ? nw.value.debug : null, newsError: err(nw, "news"),
  };

  let a: any = {};
  try {
    a = await analyze(client, now, d);
  } catch (e) {
    console.error("analysis failed:", e);
    notes.push("Plain-language summaries could not be generated this run; the items below are listed directly from ACC records.");
  }
  const subject = clean(a.subject) || `ACC Daily Briefing — ${fmtShort(now)}`;
  return {
    date: azDate(now),
    generatedAt: now,
    subject,
    html: renderHtml(now, d, a, notes),
    stats: { dockets: d.dockets.length, events: d.events.length, releases: d.releases.length, news: d.news.length },
    diagnostics: { news: d.newsDebug },
    errors: { dockets: d.docketsError, events: d.eventsError, releases: d.releasesError, news: d.newsError, analysis: notes.length ? "failed" : null },
  };
}
