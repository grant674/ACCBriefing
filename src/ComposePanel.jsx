import { useEffect, useState } from "react";

// Opened by visiting the site with #send. Passcode-protected: write a note that appears above the
// briefing in the email, save it for the next noon send, or send the email now.
const KEY = "acc-compose-code";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };
const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export default function ComposePanel() {
  const [code, setCode] = useState(read());
  const [info, setInfo] = useState(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");

  async function call(method, body) {
    const r = await fetch("/api/compose", {
      method, cache: "no-store",
      headers: { "x-admin-code": code, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (r.status === 401) { write(""); setInfo(null); }
    return j;
  }

  async function load() {
    const j = await call("GET");
    if (!j.ok) { setMsg({ err: j.error }); return; }
    write(code); setInfo(j); setMsg(null);
    if (j.note?.text && !note) setNote(j.note.text);
  }

  useEffect(() => { if (code) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(kind) {
    const recipients = kind === "full" ? info.team.length + info.distroCount : info.team.length;
    if (kind === "full" && !window.confirm(`Send the latest briefing${note.trim() ? " with your note" : ""} to everyone (${recipients} recipients) now?`)) return;
    setBusy(kind); setMsg(null);
    const j = kind === "save" ? await call("POST", { action: "save", note })
      : kind === "clear" ? await call("POST", { action: "clear" })
      : await call("POST", { action: "send", note, audience: kind });
    setBusy("");
    if (!j.ok) { setMsg({ err: j.error }); return; }
    if (kind === "clear") setNote("");
    setMsg({ ok: kind === "save" ? "Saved. It will appear above the next noon email, then clear itself."
      : kind === "clear" ? "Saved note removed."
      : kind === "team" ? `Preview sent to ${j.to.join(", ")}.`
      : `Sent to ${j.to.length} on To:${j.bcc ? ` and ${j.bcc} on Bcc` : ""}. The noon send won't resend this briefing.` });
    load();
  }

  if (!info) {
    return (
      <div className="compose">
        <strong>Compose the briefing email</strong>
        <div className="row">
          <input type="password" placeholder="Passcode" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
          <button className="primary" onClick={load} disabled={!code}>Unlock</button>
        </div>
        {msg?.err && <p className="err">{msg.err}</p>}
      </div>
    );
  }

  return (
    <div className="compose">
      <strong>Compose the briefing email</strong>
      <p className="meta">
        Latest briefing: {info.latest ? `${info.latest.subject}` : "none yet"}
        {info.latest?.analysisFailed && " ⚠ summaries failed, so regenerate it before sending to everyone"}
        <br />From {info.from} · To: {info.team.join(", ")}{info.distroCount ? ` · Bcc: ${info.distroCount} on the distribution list` : " · no distribution list yet"}
        <br />{info.sentToday ? `Today's email already went out at ${fmt(info.sentToday.at)}.` : "Today's email hasn't gone out yet (scheduled for 12:00 PM)."}
      </p>
      <label htmlFor="note">Note (appears in a box above the briefing; leave blank for none)</label>
      <textarea id="note" rows={5} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Heads up: the APS rate case hearing moves to Thursday. Call me with questions. — Grant" />
      {info.note?.text && <p className="meta">A note is saved for the next noon email (saved {fmt(info.note.savedAt)}).</p>}
      <div className="row wrap">
        <button onClick={() => act("save")} disabled={!!busy || !note.trim()}>{busy === "save" ? "Saving…" : "Save for noon email"}</button>
        {info.note?.text && <button onClick={() => act("clear")} disabled={!!busy}>Remove saved note</button>}
        <span className="spacer" />
        <button onClick={() => act("team")} disabled={!!busy || !info.latest}>{busy === "team" ? "Sending…" : "Send preview to team"}</button>
        <button className="primary" onClick={() => act("full")} disabled={!!busy || !info.latest || info.latest.analysisFailed}>{busy === "full" ? "Sending…" : "Send to everyone now"}</button>
      </div>
      {msg?.ok && <p className="ok">{msg.ok}</p>}
      {msg?.err && <p className="err">{msg.err}</p>}
    </div>
  );
}
