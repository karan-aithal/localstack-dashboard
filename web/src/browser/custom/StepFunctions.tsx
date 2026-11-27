import { useId } from "react";
import { useAws } from "../../aws";
import { Json } from "../../components/OperationForm";
import { edges, layers, type Machine, nested } from "../../sfn";

export default function Definition({ ids }: { ids: string[] }) {
  const { data, error } = useAws<{ definition: string }>("stepfunctions", "DescribeStateMachine", { stateMachineArn: ids[0] });
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  let machine: Machine;
  try {
    machine = JSON.parse(data.result.definition);
    if (!machine.States) throw new Error();
  } catch {
    return <p role="alert" className="bad">The definition could not be read.</p>;
  }
  return (
    <>
      <Graph machine={machine} />
      <details>
        <summary>Definition as JSON</summary>
        <Json value={machine} />
      </details>
    </>
  );
}

const BOX = { width: 190, height: 44, gapX: 28, gapY: 44 };
const clip = (text: string) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

function Graph({ machine }: { machine: Machine }) {
  const arrow = useId();
  const rows = layers(machine);
  const widest = Math.max(...rows.map((row) => row.length), 1);
  // the margin on the right leaves room for lines that lead back up
  const width = widest * (BOX.width + BOX.gapX) + 60;
  const height = rows.length * (BOX.height + BOX.gapY);
  const place = new Map(
    rows.flatMap((row, depth) =>
      row.map((name, i) => {
        const left = ((widest - row.length) / 2 + i) * (BOX.width + BOX.gapX) + 10;
        return [name, { x: left, y: depth * (BOX.height + BOX.gapY) + 10, depth }] as const;
      }),
    ),
  );
  const links = edges(machine);

  return (
    <>
      <div className="scroll">
        <svg className="flow" width={width} height={height} role="img" aria-label={`State machine with ${place.size} states, starting at ${machine.StartAt}. The transitions are listed below.`}>
          <defs>
            <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L8 4L0 8z" />
            </marker>
          </defs>
          {links.map(({ from, to, kind }) => {
            const a = place.get(from)!;
            const b = place.get(to)!;
            const down = b.depth > a.depth;
            // within a row the line arcs over the boxes; leading back up it goes round the side
            const across = b.depth === a.depth && from !== to;
            const side = Math.max(a.x, b.x) + BOX.width + 40;
            const path = down
              ? `M${a.x + BOX.width / 2} ${a.y + BOX.height} C${a.x + BOX.width / 2} ${a.y + BOX.height + 28}, ${b.x + BOX.width / 2} ${b.y - 28}, ${b.x + BOX.width / 2} ${b.y}`
              : across
                ? `M${a.x + BOX.width / 2} ${a.y} C${a.x + BOX.width / 2} ${a.y - 32}, ${b.x + BOX.width / 2} ${b.y - 32}, ${b.x + BOX.width / 2} ${b.y}`
                : `M${a.x + BOX.width} ${a.y + BOX.height / 2} C${side} ${a.y + BOX.height / 2}, ${side} ${b.y + BOX.height / 2}, ${b.x + BOX.width} ${b.y + BOX.height / 2}`;
            return <path key={`${from}>${to}`} className={kind} d={path} markerEnd={`url(#${arrow})`} />;
          })}
          {[...place].map(([name, { x, y }]) => {
            const state = machine.States[name];
            const last = state.End || state.Type === "Succeed" || state.Type === "Fail";
            return (
              <g key={name} className={`${name === machine.StartAt ? "start " : ""}${last ? "end" : ""}`}>
                <title>{name}</title>
                <rect x={x} y={y} width={BOX.width} height={BOX.height} rx={last ? 20 : 6} />
                <text x={x + BOX.width / 2} y={y + 19} textAnchor="middle">{clip(name)}</text>
                <text x={x + BOX.width / 2} y={y + 35} textAnchor="middle" className="kind">
                  {state.Type}{name === machine.StartAt ? " · start" : ""}{last ? " · end" : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted">Dashed lines are error handlers.</p>
      <details>
        <summary>Transitions as a table</summary>
        <table>
          <thead><tr><th>From</th><th>To</th><th>Kind</th></tr></thead>
          <tbody>
            {links.map((e) => (
              <tr key={`${e.from}>${e.to}`}><td>{e.from}</td><td>{e.to}</td><td>{e.kind}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
      {nested(machine).map(({ title, machine }) => (
        <details key={title}>
          <summary>{title}</summary>
          <Graph machine={machine} />
        </details>
      ))}
    </>
  );
}
