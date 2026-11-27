import { useState } from "react";
import { useInstanceQuery } from "../api";

type Data = {
  health: { services: Record<string, string>; version: string; edition: string; features?: Record<string, string> };
  init: {
    completed: Record<string, boolean>;
    scripts: { stage: string; name: string; state: string }[];
  } | null;
};

const TONE: Record<string, string> = { running: "good", available: "muted", error: "bad", disabled: "warn" };

export default function Status() {
  const { data, error } = useInstanceQuery<Data>("/status");
  const [filter, setFilter] = useState("");

  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;

  const services = Object.entries(data.health.services);
  const running = services.filter(([, state]) => state === "running").length;
  const shown = services.filter(([name]) => name.includes(filter.toLowerCase()));

  return (
    <>
      <h1>Status</h1>
      <div className="row">
        <input type="search" aria-label="Filter services" placeholder="Filter services" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted">
          {running} running of {services.length}. {data.health.edition} {data.health.version}.{" "}
          {Object.entries(data.health.features ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")}
        </span>
      </div>
      <ul className="grid">
        {shown.map(([name, state]) => (
          <li key={name}>
            {name}
            <span className={TONE[state] ?? ""}>{state}</span>
          </li>
        ))}
      </ul>
      {data.init && (
        <>
          <h2>Init scripts</h2>
          <p className="muted">
            Stages completed: {Object.entries(data.init.completed).filter(([, done]) => done).map(([s]) => s).join(", ") || "none"}
          </p>
          {data.init.scripts.length === 0 ? (
            <p>No init scripts. Mount scripts under /etc/localstack/init to run them.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Stage</th><th>Script</th><th>State</th></tr>
              </thead>
              <tbody>
                {data.init.scripts.map((script) => (
                  <tr key={script.stage + script.name}>
                    <td>{script.stage}</td><td>{script.name}</td><td>{script.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
