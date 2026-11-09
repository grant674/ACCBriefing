import { useEffect, useState } from "react";

// Opened by visiting the site with #send. Passcode-protected: write a note that appears above the
// briefing in the email, save it for the next noon send, or send the email now.
const KEY = "acc-compose-code";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };
const isWeekendAZ = () => ["Sat", "Sun"].includes(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", weekday: "short" }).format(new Date()));
const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export default function ComposePanel({ onClose }) {
  const [code, setCode] = useState(read());
  const [info, setInfo] = useState(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState("");
  const [listMsg, setListMsg] = useState(null);

  async function addEmails() {
    setBusy("add"); setListMsg(null);
    const j = await call("POST", { action: "distro-add", emails: adding });
    setBusy("");
    if (!j.ok) { setListMsg({ err: j.error }); return; }
    const parts = [];
    if (j.added.length) parts.push(`Added ${j.added.length}.`);
    if (j.skipped.length) parts.push(`${j.skipped.length} already on the list or on the team: ${j.skipped.join(", ")}.`);
    if (j.invalid.length) parts.push(`Couldn't read: ${j.invalid.join(", ")}.`);
    if (!parts.length) parts.push("No email addresses found.");
    setListMsg(j.added.length ? { ok: parts.join(" ") } : { err: parts.join(" ") });
    if (j.added.length) setAdding(j.invalid.join("\n"));
    load();
  }

  async function removeEmail(email) {
    setBusy("rm:" + email);
    const j = await call("POST", { action: "distro-remove", email });
    setBusy("");
    setListMsg(j.ok ? { ok: `Removed ${email}.` } : { err: j.error });
    load();
  }

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
    const already = info.sentToday && info.sentToday.state !== "failed" ? " Today's email has ALREADY gone out, so this sends it again." : "";
    if (kind === "full" && !window.confirm(`Send the latest briefing${note.trim() ? " with your note" : ""} to everyone (${recipients} recipients) now?${already}${already ? "" : " The noon send will be skipped today."}`)) return;
    setBusy(kind); setMsg(null);
    const j = kind === "save" ? await call("POST", { action: "save", note })
      : kind === "clear" ? await call("POST", { action: "clear" })
      : await call("POST", { action: "send", note, audience: kind });
    setBusy("");
    if (!j.ok) { setMsg({ err: j.error }); return; }
    if (kind === "clear") setNote("");
    setMsg({ ok: kind === "save" ? "Saved. It will appear above the next noon email (Monday–Friday), then clear itself."
      : kind === "clear" ? "Saved note removed."
      : kind === "team" ? `Preview sent to ${j.to.join(", ")}.`
      : `Sent: team copy to ${j.to.length}${j.distro ? `, plus ${j.distro} individual copies to the distribution list` : ""}.${j.failures ? ` Some batches failed: ${j.failures.join("; ")}` : ""} The noon send won't resend this briefing.` });
    load();
  }

  function lock() { write(""); setInfo(null); setCode(""); onClose?.(); }

  if (!info) {
    return (
      <div className="compose">
        <div className="row"><strong>Compose the briefing email</strong><span className="spacer" />{onClose && <button className="linklike" onClick={onClose}>Close</button>}</div>
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
      <div className="row"><strong>Compose the briefing email</strong><span className="spacer" />
        <button className="linklike" onClick={lock} title="Forget the passcode on this browser and hide this panel">Lock</button></div>
      <p className="meta">
        Latest briefing: {info.latest ? `${info.latest.subject}` : "none yet"}
        {info.latest?.analysisFailed && " ⚠ summaries failed, so regenerate it before sending to everyone"}
        <br />From {info.from} · Team (To:): {info.team.join(", ")} · Distribution list: {info.distroCount ? `${info.distroCount} (each gets their own copy)` : "empty"}
        <br />{info.sentToday?.state === "failed" ? `Today's noon send failed (${info.sentToday.error}). Use "Send to everyone now" to retry.` : info.sentToday?.state === "sending" ? "Today's email is being sent right now." : info.sentToday ? `Today's email already went out at ${fmt(info.sentToday.at)}${info.sentToday.manual ? " (sent manually)" : ""}; noon won't send again.` : (isWeekendAZ() ? "No automatic email today. The noon send runs Monday–Friday; use \"Send to everyone now\" if needed." : "Today's email hasn't gone out yet (scheduled for 12:00 PM).")}
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

      <details className="distro">
        <summary>Distribution list ({info.distroCount})</summary>
        <p className="meta">Everyone here gets their own copy of the noon email (and of "Send to everyone now"). Replies go to the team. The team is always included, so it doesn't need to be listed.</p>
        <label htmlFor="add">Add addresses (paste one or many, separated by commas or new lines)</label>
        <textarea id="add" rows={3} value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={"jane@client.com, bob@utility.com\nName <someone@example.org>"} />
        <div className="row">
          <button className="primary" onClick={addEmails} disabled={!!busy || !adding.trim()}>{busy === "add" ? "Adding…" : "Add to list"}</button>
        </div>
        {listMsg?.ok && <p className="ok">{listMsg.ok}</p>}
        {listMsg?.err && <p className="err">{listMsg.err}</p>}
        {info.distro.length > 0 && (
          <ul className="distro-list">
            {info.distro.map((e) => (
              <li key={e}><span>{e}</span><button onClick={() => removeEmail(e)} disabled={!!busy} aria-label={`Remove ${e}`}>{busy === "rm:" + e ? "…" : "Remove"}</button></li>
            ))}
          </ul>
        )}
        {info.envDistro?.length > 0 && <p className="meta">Also set in Netlify (BRIEFING_RECIPIENTS): {info.envDistro.join(", ")}</p>}
      </details>
    </div>
  );
}
