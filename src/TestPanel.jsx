import { useEffect, useState } from "react";

// Opened by visiting the site with #send-test. Sends the latest briefing to chosen team members only.
export default function TestPanel() {
  const [cfg, setCfg] = useState(null);
  const [picked, setPicked] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/send-test", { cache: "no-store" }).then((r) => r.json()).then((c) => {
      setCfg(c);
      setPicked(c.team.filter((a) => !/^jessica@/i.test(a)));
    }).catch((e) => setCfg({ error: String(e) }));
  }, []);

  async function send() {
    setBusy(true); setResult(null);
    try {
      const r = await fetch("/api/send-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: picked }) });
      setResult(await r.json());
    } catch (e) { setResult({ ok: false, error: String(e) }); }
    setBusy(false);
  }

  if (!cfg) return null;
  return (
    <div className="test-panel">
      <strong>Send a test email</strong>
      {cfg.error ? <p className="tp-err">{cfg.error}</p> : (
        <>
          <p>From <code>{cfg.from}</code> · {cfg.hasKey ? "Resend key found" : "⚠ RESEND_API_KEY not set yet"}</p>
          {cfg.team.map((a) => (
            <label key={a}><input type="checkbox" checked={picked.includes(a)} onChange={(e) => setPicked(e.target.checked ? [...picked, a] : picked.filter((x) => x !== a))} /> {a}</label>
          ))}
          <button className="primary" onClick={send} disabled={busy || !picked.length || !cfg.hasKey}>{busy ? "Sending…" : `Send test to ${picked.length}`}</button>
          {result && (result.ok
            ? <p className="tp-ok">Sent to {result.to.join(", ")}. Check those inboxes (and spam) in a minute.</p>
            : <p className="tp-err">{result.error}</p>)}
        </>
      )}
    </div>
  );
}
