import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";
import { Json } from "../components/OperationForm";
import { caller, flow, isError, isWarning, millis, participant, payload, type Span, type Trace, traces } from "../inspector";

type Status = { status: string };
type Spans = { spans: Span[]; limits?: { span_count_limit_license?: number } };

const clock = (nano: string | null) => (nano ? new Date(millis(nano)).toISOString().slice(11, 23) : "");

export default function AppInspector() {
  const instance = useInstance();
  const status = useInstanceQuery<Status>("/appinspector/status");
  const change = useMutation({
    mutationFn: (wanted: string) => api(instancePath(instance, "/appinspector/status"), "PUT", { status: wanted }),
    onSettled: () => status.refetch(),
  });
  const error = status.error ?? change.error;
  const enabled = status.data?.status === "ENABLED";

  return (
    <>
      <h1>App Inspector</h1>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {status.data && !enabled && (
        <>
          <p>
            App Inspector is {status.data.status.toLowerCase()}. When enabled, the instance records the operations it
            serves, including request payloads, until it restarts or you clear them.
          </p>
          <button className="primary" disabled={change.isPending} onClick={() => change.mutate("ENABLED")}>
            Enable App Inspector
          </button>
        </>
      )}
      {enabled && <Requests onDisable={() => change.mutate("DISABLED")} />}
    </>
  );
}

function Requests({ onDisable }: { onDisable: () => void }) {
  const instance = useInstance();
  const [live, setLive] = useState(true);
  // ponytail: polling; the instance also offers a websocket, worth proxying if two seconds is too slow
  const { data, error, refetch } = useInstanceQuery<Spans>("/appinspector/spans", live ? 2000 : false);
  const [search, setSearch] = useState("");
  const [only, setOnly] = useState<"all" | "errors" | "warnings">("all");
  const [consumer, setConsumer] = useState("");
  const [open, setOpen] = useState<string>();
  const clear = useMutation({
    mutationFn: () => api(instancePath(instance, "/appinspector/traces"), "DELETE"),
    onSettled: () => {
      setOpen(undefined);
      return refetch();
    },
  });

  const all = traces(data?.spans ?? []);
  const wanted = search.toLowerCase();
  const shown = all.filter(
    (t) =>
      (only !== "errors" || t.errors > 0) &&
      (only !== "warnings" || t.warnings > 0) &&
      (!consumer || t.consumer === consumer) &&
      t.spans.some((s) => `${s.service_name} ${s.operation_name} ${s.resource_name}`.toLowerCase().includes(wanted)),
  );
  const consumers = [...new Set(all.map((t) => t.consumer))].sort();
  const trace = all.find((t) => t.id === open);
  const limit = data?.limits?.span_count_limit_license;
  const counts = { all: all.length, errors: all.filter((t) => t.errors).length, warnings: all.filter((t) => t.warnings).length };
  const failure = error ?? clear.error;

  return (
    <>
      <div className="row">
        <input type="search" aria-label="Search operations" placeholder="Search operations" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div role="group" aria-label="Show" className="inline">
          {(["all", "errors", "warnings"] as const).map((kind) => (
            <button key={kind} aria-pressed={only === kind} onClick={() => setOnly(kind)}>
              {kind[0].toUpperCase() + kind.slice(1)} ({counts[kind]})
            </button>
          ))}
        </div>
        <select aria-label="Consumer" value={consumer} onChange={(e) => setConsumer(e.target.value)}>
          <option value="">Any consumer</option>
          {consumers.map((name) => <option key={name}>{name}</option>)}
        </select>
        <label className="choice"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />Live</label>
        {!live && <button onClick={() => refetch()}>Refresh</button>}
        <button className="danger" disabled={all.length === 0 || clear.isPending}
          onClick={() => window.confirm(`Delete all recorded operations of instance "${instance}"? This cannot be undone.`) && clear.mutate()}>
          Clear operations
        </button>
        <button onClick={onDisable}>Disable</button>
      </div>
      {limit && <p className="muted">Your plan stores {limit} operations. Further ones are not recorded until you clear them.</p>}
      {failure && <p role="alert" className="bad">{failure.message}</p>}
      {data && shown.length === 0 && <p className="muted">{all.length ? "No request matches." : "Nothing recorded yet. Call any service on the instance."}</p>}
      {shown.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Time (UTC)</th><th>Action</th><th>Consumer</th><th>Resource</th><th>Request details</th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} aria-selected={t.id === open}>
                  <td>{clock(t.root.start_time_unix_nano)}</td>
                  <td><button className="link" onClick={() => setOpen(t.id)}>{t.root.service_name}.{t.root.operation_name}</button></td>
                  <td>{t.consumer}</td>
                  <td>{t.root.resource_name}</td>
                  <td>
                    Operations: {t.spans.length}
                    {t.errors > 0 && <span className="bad"> · errors: {t.errors}</span>}
                    {t.warnings > 0 && <span className="warn"> · warnings: {t.warnings}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {trace && <Request key={trace.id} trace={trace} onClose={() => setOpen(undefined)} />}
    </>
  );
}

const VIEWS = ["Flow", "Operations", "Sequence"] as const;

function Request({ trace, onClose }: { trace: Trace; onClose: () => void }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>("Flow");
  const [selected, setSelected] = useState(trace.root.span_id);
  const span = trace.spans.find((s) => s.span_id === selected) ?? trace.root;

  return (
    <section aria-label="Request">
      <div className="row">
        <h2>{trace.root.service_name}.{trace.root.operation_name}</h2>
        <div role="group" aria-label="View" className="inline">
          {VIEWS.map((name) => (
            <button key={name} aria-pressed={view === name} onClick={() => setView(name)}>{name}</button>
          ))}
        </div>
        <button onClick={onClose}>Close</button>
      </div>
      {view === "Flow" && <Flow spans={trace.spans} />}
      {view === "Sequence" && <Sequence spans={trace.spans} />}
      {/* the table is also how an operation is picked from the drawings */}
      <div className="scroll">
        <table>
          <thead><tr><th>Started</th><th>Operation</th><th>Caller</th><th>Target</th><th>Duration</th><th>Status</th></tr></thead>
          <tbody>
            {trace.spans.map((s) => (
              <tr key={s.span_id} aria-selected={s === span}>
                <td>{clock(s.start_time_unix_nano)}</td>
                <td><button className="link" onClick={() => setSelected(s.span_id)}>{s.service_name}.{s.operation_name}</button></td>
                <td>{caller(s, trace.spans)}</td>
                <td>{participant(s)}</td>
                <td>{duration(s)}</td>
                <td className={isError(s) ? "bad" : isWarning(s) ? "warn" : "good"}>{s.operation_status.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Operation key={span.span_id} span={span} />
    </section>
  );
}

const duration = (s: Span) =>
  s.end_time_unix_nano && s.start_time_unix_nano
    ? `${(millis(s.end_time_unix_nano) - millis(s.start_time_unix_nano)).toFixed(1)} ms`
    : "";

const TABS = ["Details", "Payload", "Response", "Permissions", "Advanced"] as const;

function Operation({ span }: { span: Span }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Details");
  const rows: [string, unknown][] =
    tab === "Details"
      ? [
          ["Service", span.service_name], ["Action", span.operation_name], ["Resource", span.resource_name], ["ARN", span.arn],
          ["Account", span.account_id], ["Region", span.region], ["Started (UTC)", clock(span.start_time_unix_nano)], ["Duration", duration(span)],
          ["HTTP status", span.attributes?.["http.status_code"]], ["Message", span.status_message],
        ]
      : [
          ["Span ID", span.span_id], ["Trace ID", span.trace_id], ["Parent span ID", span.parent_span_id],
          ["Request ID", span.attributes?.["localstack.request_id"]], ["Kind", span.kind],
        ];
  const body = tab === "Payload" ? payload(span, "request") : tab === "Response" ? payload(span, "response") : null;

  return (
    <>
      <div className="tabs" role="group" aria-label={`${span.operation_name} details`}>
        {TABS.map((name) => (
          <button key={name} aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>
      {(tab === "Details" || tab === "Advanced") && (
        <table>
          <tbody>
            {rows.map(([name, value]) => (
              <tr key={name}><th scope="row">{name}</th><td>{String(value ?? "")}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "Advanced" && (
        <details><summary>All attributes</summary><Json value={span.attributes} /></details>
      )}
      {(tab === "Payload" || tab === "Response") &&
        (body ? <pre className="response" tabIndex={0}>{body}</pre> : <p className="muted">The instance did not record this {tab.toLowerCase()}.</p>)}
      {tab === "Permissions" && <Permissions span={span} />}
    </>
  );
}

function Permissions({ span }: { span: Span }) {
  const { data, error } = useInstanceQuery<{ events: unknown[] }>(`/appinspector/spans/${span.trace_id}/${span.span_id}/iam`, false);
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      {span.iam_errors_suppressed && <p className="warn">IAM errors are hidden on your plan.</p>}
      {data.events.length ? <Json value={data.events} /> : <p className="muted">No IAM evaluation was recorded for this operation.</p>}
      <p className="muted">Automatically derived policies need a higher plan.</p>
    </>
  );
}

const BOX = { width: 180, height: 40, gapX: 140, gapY: 24 };
const clip = (text: string, length = 26) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

function Flow({ spans }: { spans: Span[] }) {
  const arrow = useId();
  const { columns, links } = flow(spans);
  const tallest = Math.max(...columns.map((c) => c.length), 1);
  const width = columns.length * (BOX.width + BOX.gapX) - BOX.gapX + 20;
  const height = tallest * (BOX.height + BOX.gapY) + 30;
  const place = new Map(
    columns.flatMap((names, x) =>
      names.map((name, y) => [name, { x: x * (BOX.width + BOX.gapX) + 10, y: y * (BOX.height + BOX.gapY) + 30 }] as const),
    ),
  );

  return (
    <div className="scroll">
      <svg className="flow" width={width} height={height} role="img" aria-label="Which resources called which. The same is listed in the table below.">
        <defs>
          <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
        </defs>
        {links.map(({ from, to, operations, failed }) => {
          const a = place.get(from)!;
          const b = place.get(to)!;
          const forward = b.x > a.x;
          const start = { x: a.x + (forward ? BOX.width : BOX.width / 2), y: a.y + (forward ? BOX.height / 2 : 0) };
          const end = { x: b.x + (forward ? 0 : BOX.width / 2), y: b.y + (forward ? BOX.height / 2 : 0) };
          const bend = forward ? `C${start.x + 60} ${start.y}, ${end.x - 60} ${end.y}` : `C${start.x} ${start.y - 30}, ${end.x} ${end.y - 30}`;
          return (
            <g key={`${from}>${to}`}>
              <path className={failed ? "failed" : undefined} d={`M${start.x} ${start.y} ${bend}, ${end.x} ${end.y}`} markerEnd={`url(#${arrow})`} />
              <text className="kind" x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - (forward ? 6 : 26)} textAnchor="middle">
                {clip(`${operations.join(", ")}${failed ? " (failed)" : ""}`, 22)}
              </text>
            </g>
          );
        })}
        {[...place].map(([name, { x, y }]) => (
          <g key={name}>
            <title>{name}</title>
            <rect x={x} y={y} width={BOX.width} height={BOX.height} rx={6} />
            <text x={x + BOX.width / 2} y={y + 25} textAnchor="middle">{clip(name)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Sequence({ spans }: { spans: Span[] }) {
  const arrow = useId();
  const names = [...new Set(spans.flatMap((s) => [caller(s, spans), participant(s)]))];
  const lane = 210;
  const step = 38;
  const x = (name: string) => names.indexOf(name) * lane + lane / 2;
  const height = spans.length * step + 60;

  return (
    <div className="scroll">
      <svg className="flow" width={names.length * lane} height={height} role="img" aria-label="Calls in the order they happened. The same is listed in the table below.">
        <defs>
          <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
        </defs>
        {names.map((name) => (
          <g key={name}>
            <title>{name}</title>
            <text x={x(name)} y={16} textAnchor="middle">{clip(name, 30)}</text>
            <line className="lifeline" x1={x(name)} x2={x(name)} y1={24} y2={height} />
          </g>
        ))}
        {spans.map((s, i) => {
          const from = x(caller(s, spans));
          const to = x(participant(s));
          const y = i * step + 60;
          // a resource calling itself is drawn as a small loop
          const d = from === to ? `M${from} ${y - 10} h40 v14 h-38` : `M${from} ${y} H${to}`;
          return (
            <g key={s.span_id}>
              <path className={isError(s) ? "failed" : undefined} d={d} markerEnd={`url(#${arrow})`} />
              <text className="kind" x={from === to ? from + 48 : (from + to) / 2} y={y - 6} textAnchor={from === to ? "start" : "middle"}>
                {i + 1}. {s.operation_name}{isError(s) ? " (failed)" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
