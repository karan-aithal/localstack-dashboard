/** Stack Insights: the runs of the instance and, per run, its calls over time, by service and one by one. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";

type Session = { id: number; version: string; state: string; ended: number; ok: number; failed: number; services: number };
type Counts = { ok: number; failed: number };
type Bucket = Counts & { at: number };
type Event = { ts: string; at: number; service: string; operation: string; status: number; error: string };
type Detail = {
  session: Session;
  start: number;
  end: number;
  width: number;
  timeline: Bucket[];
  services: (Counts & { service: string })[];
  events: Event[];
  names: string[];
  error: string | null;
};

const clock = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

function duration(seconds: number) {
  const parts = [[Math.floor(seconds / 3600), "h"], [Math.floor(seconds / 60) % 60, "m"], [seconds % 60, "s"]] as const;
  const first = parts.findIndex(([value]) => value > 0);
  // the two largest units are enough
  return first < 0 ? "0 s" : parts.slice(first, first + 2).map(([value, unit]) => `${value} ${unit}`).join(" ");
}

const unread = (reason: string) => (
  <p role="alert" className="warn">The container log cannot be read, so only stored runs are shown: {reason}</p>
);

export default function Insights() {
  const { session } = useParams();
  return session ? <Run key={session} id={session} /> : <Runs />;
}

function Runs() {
  const { data, error } = useInstanceQuery<{ sessions: Session[]; error: string | null }>("/insights/sessions");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(20);
  const wanted = search.toLowerCase();
  const found = (data?.sessions ?? []).filter((s) =>
    `${s.id} ${clock(s.id)} ${s.state} ${s.version}`.toLowerCase().includes(wanted),
  );

  return (
    <>
      <h1>Stack Insights</h1>
      <p className="muted">
        One session for each run of the instance, read from its container log. The data stays on this machine. Calls made
        by this dashboard count too.
      </p>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data?.error && unread(data.error)}
      <div className="row">
        <input type="search" aria-label="Filter sessions" placeholder="Filter sessions" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {data && found.length === 0 && (
        <p className="muted">{data.sessions.length ? "No session matches." : "No session found in the container log."}</p>
      )}
      {found.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Session</th><th>Start time (UTC)</th><th>State</th><th>Version</th><th>Runtime</th><th>Successful calls</th><th>Failed calls</th><th>Services</th></tr>
            </thead>
            <tbody>
              {found.slice(0, limit).map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/insights/${s.id}`}>{s.id}</Link></td>
                  <td>{clock(s.id)}</td>
                  <td className={s.state === "running" ? "good" : "muted"}>{s.state}</td>
                  <td>{s.version || "unknown"}</td>
                  <td>{duration(s.ended - s.id)}</td>
                  <td>{s.ok}</td>
                  <td className={s.failed ? "bad" : undefined}>{s.failed}</td>
                  <td>{s.services}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {found.length > limit && <button onClick={() => setLimit(limit + 20)}>Load more</button>}
    </>
  );
}

function Run({ id }: { id: string }) {
  const instance = useInstance();
  // an end left unset follows the run while it goes on
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const [service, setService] = useState("");
  const [failed, setFailed] = useState(false);
  const query = new URLSearchParams();
  if (from !== undefined) query.set("start", String(from));
  if (to !== undefined) query.set("end", String(to));
  if (service) query.set("service", service);
  if (failed) query.set("failed", "true");
  const suffix = `/insights/sessions/${encodeURIComponent(id)}?${query}`;
  const { data, error } = useQuery({
    queryKey: [instance, suffix],
    queryFn: () => api<Detail>(instancePath(instance, suffix)),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });

  const ok = data?.services.reduce((sum, s) => sum + s.ok, 0) ?? 0;
  const errored = data?.services.reduce((sum, s) => sum + s.failed, 0) ?? 0;
  const most = Math.max(1, ...(data?.services.map((s) => s.ok + s.failed) ?? []));

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol><li><Link to="/insights">Stack Insights</Link></li><li>{id}</li></ol>
      </nav>
      <h1>Session {id}</h1>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data && (
        <>
          {data.error && unread(data.error)}
          <p className="muted">
            Started {clock(data.session.id)} UTC, {data.session.state}, runtime {duration(data.session.ended - data.session.id)},
            version {data.session.version || "unknown"}.
          </p>
          <div className="row">
            <label className="choice">
              From
              <input type="range" min={data.session.id} max={data.session.ended} value={from ?? data.session.id}
                aria-valuetext={clock(from ?? data.session.id)}
                onChange={(e) => {
                  const value = Math.min(Number(e.target.value), to ?? data.session.ended);
                  setFrom(value === data.session.id ? undefined : value);
                }} />
            </label>
            <label className="choice">
              To
              <input type="range" min={data.session.id} max={data.session.ended} value={to ?? data.session.ended}
                aria-valuetext={clock(to ?? data.session.ended)}
                onChange={(e) => {
                  const value = Math.max(Number(e.target.value), from ?? data.session.id);
                  setTo(value >= data.session.ended ? undefined : value);
                }} />
            </label>
            <select aria-label="Service" value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">All services</option>
              {data.names.map((name) => <option key={name}>{name}</option>)}
            </select>
            <label className="choice"><input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} />Failed only</label>
            <button disabled={!query.size} onClick={() => { setFrom(undefined); setTo(undefined); setService(""); setFailed(false); }}>
              Reset filters
            </button>
          </div>
          <p>
            <strong>{ok + errored}</strong> calls from {clock(data.start)} to {clock(data.end)} UTC: {ok} successful,{" "}
            <span className={errored ? "bad" : undefined}>{errored} failed</span>.
          </p>
          {ok + errored === 0 ? (
            <p className="muted">No call matches. An instance logging below the info level records none.</p>
          ) : (
            <>
              <figure>
                <figcaption>API calls per {duration(data.width)}</figcaption>
                <Columns buckets={data.timeline} end={data.end} />
              </figure>
              <h2>Service invocations</h2>
              <div className="scroll">
                <table>
                  <thead><tr><th>Service</th><th className="wide">Calls</th><th>Successful</th><th>Failed</th></tr></thead>
                  <tbody>
                    {data.services.map((s) => (
                      <tr key={s.service}>
                        <td>{s.service}</td>
                        <td>
                          <span className="meter" aria-hidden="true">
                            {s.ok > 0 && <span className="ok" style={{ width: `${(s.ok / most) * 100}%` }} />}
                            {s.failed > 0 && <span className="failed" style={{ width: `${(s.failed / most) * 100}%` }} />}
                          </span>
                        </td>
                        <td>{s.ok}</td>
                        <td>{s.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h2>Events</h2>
              {data.events.length < ok + errored && <p className="muted">The latest {data.events.length} are listed. Narrow the time range to see earlier ones.</p>}
              <div className="scroll">
                <table>
                  <thead><tr><th>Server time (UTC)</th><th>Service</th><th>Operation</th><th>Status code</th></tr></thead>
                  <tbody>
                    {data.events.map((e) => (
                      <tr key={`${e.ts} ${e.service} ${e.operation}`}>
                        <td>{clock(e.at)}</td>
                        <td>{e.service}</td>
                        <td>{e.operation}</td>
                        <td className={e.status >= 400 ? "bad" : undefined}>{e.status} {e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">The log does not name the client that made a call, so clients are not shown.</p>
            </>
          )}
        </>
      )}
    </>
  );
}

const WIDTH = 800;
const HEIGHT = 220;
const PAD = { left: 48, right: 12, top: 12, bottom: 28 };
const BASE = HEIGHT - PAD.bottom;

/** A column part, rounded at its top if nothing sits on it. */
function column(x: number, y: number, width: number, height: number, rounded: boolean) {
  const r = rounded ? Math.min(4, width / 2, height) : 0;
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** Successful and failed calls per time bucket, stacked. */
function Columns({ buckets, end }: { buckets: Bucket[]; end: number }) {
  const [at, setAt] = useState<number>();
  const most = Math.max(1, ...buckets.map((b) => b.ok + b.failed));
  const slot = (WIDTH - PAD.left - PAD.right) / buckets.length;
  const width = Math.min(24, Math.max(1, slot - 2));
  // anything counted stays visible, however small beside the largest column
  const size = (count: number) => (count ? Math.max(2, (count / most) * (BASE - PAD.top)) : 0);
  // the buckets change under the pointer when a filter does
  const point = at === undefined ? undefined : buckets[at];

  const hover = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    setAt(Math.min(buckets.length - 1, Math.max(0, Math.floor((x - PAD.left) / slot))));
  };
  const step = (event: KeyboardEvent) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!move) return;
    event.preventDefault();
    setAt((old) => (old === undefined ? buckets.length - 1 : Math.min(buckets.length - 1, Math.max(0, old + move))));
  };

  return (
    <>
      <p className="legend"><span className="ok" aria-hidden="true" />Successful<span className="failed" aria-hidden="true" />Failed</p>
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0}
        aria-label={`Column chart of API calls over ${buckets.length} time buckets. Use the arrow keys to read values.`}
        onPointerMove={hover} onPointerLeave={() => setAt(undefined)} onKeyDown={step} onBlur={() => setAt(undefined)}>
        {[...new Set([0, Math.round(most / 2), most])].map((tick) => {
          const y = BASE - (tick / most) * (BASE - PAD.top);
          return (
            <g key={tick}>
              <line className={tick === 0 ? "axis" : "grid-line"} x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />
              <text x={PAD.left - 8} y={y + 4} textAnchor="end">{tick}</text>
            </g>
          );
        })}
        {point && <rect className="highlight" x={PAD.left + at! * slot} y={PAD.top} width={slot} height={BASE - PAD.top} />}
        {buckets.map((b, i) => {
          const x = PAD.left + i * slot + (slot - width) / 2;
          const ok = size(b.ok);
          const failed = size(b.failed);
          return (
            <g key={b.at}>
              {ok > 0 && <path className="ok" d={column(x, BASE - ok, width, ok, !failed)} />}
              {failed > 0 && <path className="failed" d={column(x, BASE - ok - (ok && 2) - failed, width, failed, true)} />}
            </g>
          );
        })}
        <text x={PAD.left} y={HEIGHT - 8}>{clock(buckets[0].at)}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end">{clock(end)} UTC</text>
      </svg>
      <p role="status" className="readout">
        {point
          ? <><strong>{point.ok} successful, {point.failed} failed</strong> <span className="muted">from {clock(point.at)} UTC</span></>
          : <span className="muted">Point at a column to read its values.</span>}
      </p>
      <details>
        <summary>Values as a table</summary>
        <table>
          <thead><tr><th>From (UTC)</th><th>Successful</th><th>Failed</th></tr></thead>
          <tbody>
            {buckets.filter((b) => b.ok || b.failed).map((b) => (
              <tr key={b.at}><td>{clock(b.at)}</td><td>{b.ok}</td><td>{b.failed}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}
