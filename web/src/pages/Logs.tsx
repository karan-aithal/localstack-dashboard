import { useEffect, useRef, useState } from "react";
import { instancePath, useInstance } from "../api";

const KEEP = 5000;
const LEVELS = ["ALL", "DEBUG", "INFO", "WARN", "ERROR"];

export default function Logs() {
  const name = useInstance();
  const [lines, setLines] = useState<{ id: number; text: string }[]>([]);
  const [state, setState] = useState("connecting");
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState("ALL");
  const [follow, setFollow] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let id = 0;
    let pending: { id: number; text: string }[] = [];
    const source = new EventSource(instancePath(name, "/logs"));
    // batched: rendering once per line freezes the page on a busy instance
    const flush = setInterval(() => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setLines((old) => [...old, ...batch].slice(-KEEP));
    }, 250);
    source.onopen = () => {
      // a reconnect replays the tail, so start over
      pending = [];
      setLines([]);
      setState("live");
    };
    source.onmessage = (event) => pending.push({ id: id++, text: event.data });
    source.addEventListener("end", () => {
      source.close();
      setState("ended");
    });
    source.onerror = () => setState("disconnected");
    return () => {
      source.close();
      clearInterval(flush);
    };
  }, [name, attempt]);

  const needle = filter.toLowerCase();
  const shown = lines.filter(
    ({ text }) =>
      (level === "ALL" || new RegExp(`\\s${level}\\s`).test(text)) && text.toLowerCase().includes(needle),
  );

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });

  return (
    <>
      <h1>Logs</h1>
      <div className="row">
        <input type="search" aria-label="Filter logs" placeholder="Filter text" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l}>{l}</option>)}
        </select>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button onClick={() => setLines([])}>Clear</button>
        {state === "ended" && <button onClick={() => { setState("connecting"); setAttempt(attempt + 1); }}>Reconnect</button>}
        <span role="status" className={state === "live" ? "good" : "warn"}>{state}</span>
        <span className="muted">{shown.length} of {lines.length} lines</span>
      </div>
      <pre className="logs" ref={box} tabIndex={0}>
        {shown.map((line) => <div key={line.id}>{line.text}</div>)}
      </pre>
    </>
  );
}
