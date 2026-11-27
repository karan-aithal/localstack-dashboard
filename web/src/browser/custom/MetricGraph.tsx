/** One metric over time: a single line, with a crosshair readout and the values as a table. */

import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { useAws } from "../../aws";

type Data = { MetricDataResults: { Timestamps?: string[]; Values?: number[] }[] };

const RANGES = [
  { label: "Last hour", minutes: 60, period: 60 },
  { label: "Last 3 hours", minutes: 180, period: 60 },
  { label: "Last 24 hours", minutes: 1440, period: 300 },
  { label: "Last 7 days", minutes: 10080, period: 3600 },
];
const STATISTICS = ["Average", "Sum", "Minimum", "Maximum", "SampleCount"];

export default function MetricGraph({ ids }: { ids: string[] }) {
  const metric = JSON.parse(ids[0]) as { Namespace: string; MetricName: string; Dimensions: unknown[] };
  const [range, setRange] = useState(0);
  const [statistic, setStatistic] = useState("Average");
  // the window only moves on request, so that the query stays the same between renders
  const [now, setNow] = useState(() => Date.now());
  const { minutes, period } = RANGES[range];
  const start = now - minutes * 60_000;
  // end a minute ahead, so that the period in progress is included
  const end = now + 60_000;
  const { data, error, isFetching } = useAws<Data>("cloudwatch", "GetMetricData", {
    StartTime: new Date(start).toISOString(),
    EndTime: new Date(end).toISOString(),
    MetricDataQueries: [{ Id: "m", MetricStat: { Metric: metric, Period: period, Stat: statistic } }],
  });
  const result = data?.result.MetricDataResults[0];
  const points = (result?.Timestamps ?? [])
    .map((time, i) => ({ time: Date.parse(time), value: result!.Values![i] }))
    .sort((a, b) => a.time - b.time);

  return (
    <>
      <div className="row">
        <select aria-label="Statistic" value={statistic} onChange={(e) => setStatistic(e.target.value)}>
          {STATISTICS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Time range" value={range} onChange={(e) => setRange(Number(e.target.value))}>
          {RANGES.map(({ label }, i) => (
            <option key={label} value={i}>{label}</option>
          ))}
        </select>
        <button onClick={() => setNow(Date.now())} disabled={isFetching}>Refresh</button>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data && points.length === 0 && <p className="muted">No data in this time range.</p>}
      {points.length > 0 && (
        <figure>
          <figcaption>{metric.MetricName}: {statistic.toLowerCase()} per {period / 60} min</figcaption>
          <Line points={points} start={start} end={end} />
          <details>
            <summary>Values as a table</summary>
            <table>
              <thead><tr><th>Time (UTC)</th><th>{statistic}</th></tr></thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.time}><td>{clock(p.time)}</td><td>{p.value}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </figure>
      )}
    </>
  );
}

const WIDTH = 800;
const HEIGHT = 240;
const PAD = { left: 64, right: 12, top: 12, bottom: 28 };

const clock = (time: number) => new Date(time).toISOString().slice(0, 16).replace("T", " ");
const short = (value: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);

function Line({ points, start, end }: { points: { time: number; value: number }[]; start: number; end: number }) {
  const [at, setAt] = useState<number>();
  const low = Math.min(0, ...points.map((p) => p.value));
  const high = Math.max(0, ...points.map((p) => p.value));
  const span = high - low || 1;
  const x = (time: number) => PAD.left + ((time - start) / (end - start)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - (value - low) / span) * (HEIGHT - PAD.top - PAD.bottom);
  const ticks = [low, low + span / 2, low + span];

  const hover = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const pointer = ((event.clientX - box.left) / box.width) * WIDTH;
    let nearest = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.time) - pointer) < Math.abs(x(points[nearest].time) - pointer)) nearest = i;
    });
    setAt(nearest);
  };
  const step = (event: KeyboardEvent) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!move) return;
    event.preventDefault();
    setAt((old) => Math.min(points.length - 1, Math.max(0, (old ?? points.length - 1) + (old === undefined ? 0 : move))));
  };
  const point = at === undefined ? undefined : points[at];

  return (
    <>
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0}
        aria-label={`Line chart, ${points.length} data points. Use the arrow keys to read values.`}
        onPointerMove={hover} onPointerLeave={() => setAt(undefined)} onKeyDown={step} onBlur={() => setAt(undefined)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "axis" : "grid-line"} x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">{short(tick)}</text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 8}>{clock(start)}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end">{clock(end)} UTC</text>
        <polyline className="series" points={points.map((p) => `${x(p.time)},${y(p.value)}`).join(" ")} />
        {/* single points would otherwise be invisible */}
        {points.length < 40 && points.map((p) => <circle key={p.time} className="dot" cx={x(p.time)} cy={y(p.value)} r={4} />)}
        {point && (
          <>
            <line className="crosshair" x1={x(point.time)} x2={x(point.time)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
            <circle className="dot" cx={x(point.time)} cy={y(point.value)} r={5} />
          </>
        )}
      </svg>
      <p role="status" className="readout">
        {point ? <><strong>{point.value}</strong> <span className="muted">at {clock(point.time)} UTC</span></> : <span className="muted">Point at the line to read a value.</span>}
      </p>
    </>
  );
}
