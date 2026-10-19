import { useCallback, useEffect, useRef, useState } from "react";

const fmtWhen = (ms) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const fmtDate = (ymd) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));

export default function App() {
  const [data, setData] = useState(null);
  const [date, setDate] = useState("");
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState("");
  const [starting, setStarting] = useState(false);
  const sheetRef = useRef(null);

  const load = useCallback(async (d = date) => {
    try {
      const res = await fetch(`/api/briefing${d ? `?date=${d}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setLoadError("");
    } catch (e) {
      setLoadError(`Couldn't load the briefing (${e.message}).`);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const running = data?.status?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [running, load]);

  async function generate() {
    setStarting(true);
    try {
      await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger: "manual" }) });
      setDate("");
      setTimeout(() => load(""), 1500);
    } finally {
      setTimeout(() => setStarting(false), 1500);
    }
  }

  async function copyRich(html, text, which) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
    setCopied(which);
    setTimeout(() => setCopied(""), 2500);
  }

  function savePdf() {
    // Print layout (styles.css @media print) hides the app chrome; the title becomes the default PDF filename.
    const prev = document.title;
    document.title = `ACC Daily Briefing ${b.date}`;
    const restore = () => { document.title = prev; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  const b = data?.briefing;
  const status = data?.status;

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <p className="kicker">Arizona Corporation Commission</p>
          <h1>ACC Daily Briefing</h1>
          <p className="when">
            {b ? `Generated ${fmtWhen(b.generatedAt)} Arizona time` : "Dockets · hearings · releases · press"}
          </p>
        </div>
        {data?.dates?.length > 1 && (
          <select value={date} onChange={(e) => setDate(e.target.value)} aria-label="Choose a briefing date">
            <option value="">Latest</option>
            {data.dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
          </select>
        )}
      </header>

      {running && (
        <div className="banner run"><span className="spin" /> Building a fresh briefing — this usually takes 1–3 minutes. This page updates on its own.</div>
      )}
      {status?.state === "error" && !running && (
        <div className="banner err">The last run failed: {status.error}</div>
      )}
      {loadError && <div className="banner err">{loadError}</div>}

      {b ? (
        <>
          <div className="toolbar">
            <button className={copied === "body" ? "copied" : "primary"} onClick={() => copyRich(sheetRef.current.innerHTML, sheetRef.current.innerText, "body")}>
              {copied === "body" ? "Copied — paste into Gmail" : "Copy for Gmail"}
            </button>
            <button onClick={savePdf} title="Opens the print dialog — choose “Save as PDF” as the destination">Save as PDF</button>
            <span className="spacer" />
            <button onClick={generate} disabled={running || starting}>{running || starting ? "Working…" : "Regenerate now"}</button>
          </div>
          <div className="subject">
            <b>Subject</b> <span>{b.subject}</span>
            <button className={copied === "subject" ? "copied" : ""} onClick={() => copyRich(b.subject, b.subject, "subject")}>
              {copied === "subject" ? "Copied" : "Copy"}
            </button>
          </div>
          <article className="sheet" ref={sheetRef} dangerouslySetInnerHTML={{ __html: b.html }} />
          <p className="foot">A new briefing is built automatically every morning at 6:00 AM Arizona time.</p>
        </>
      ) : (
        data && (
          <div className="sheet empty">
            <h2>No briefing yet</h2>
            <p>The first one builds automatically at 6:00 AM Arizona time, or you can start one now.</p>
            <button className="primary" onClick={generate} disabled={running || starting}>
              {running || starting ? "Working…" : "Generate today's briefing"}
            </button>
          </div>
        )
      )}
    </div>
  );
}
