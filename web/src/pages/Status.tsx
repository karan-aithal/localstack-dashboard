import { useState } from "react";
import { useInstanceQuery } from "../api";

type Data = {
  health: { services: Record<string, string>; version: string; edition: string; features?: Record<string, string> };
  init: {
    completed: Record<string, boolean>;
    scripts: { stage: string; name: string; state: string }[];
  } | null;
};

type Service = { id: string; title: string };

const TONE: Record<string, string> = { running: "good", available: "muted", error: "bad", disabled: "warn" };

export default function Status() {
  const { data, error } = useInstanceQuery<Data>("/status");
  const names = useInstanceQuery<Service[]>("/services", false);
  const [filter, setFilter] = useState("");

  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;

  const services = Object.entries(data.health.services);
  const running = services.filter(([, state]) => state === "running").length;
  // full names come from the AWS definitions; until then, and for the rest, the short name stands in
  const titles = new Map(names.data?.map((s) => [s.id, s.title]));
  const shown = services.filter(([id]) => `${id} ${titles.get(id) ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const sections = [
    { title: "Running", items: shown.filter(([, state]) => state === "running") },
    { title: "Available", items: shown.filter(([, state]) => state === "available") },
    { title: "Other", items: shown.filter(([, state]) => state !== "running" && state !== "available") },
  ].filter((section) => section.items.length > 0);

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
      {sections.length === 0 && <p className="muted">No service matches.</p>}
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title} ({section.items.length})</h2>
          <ul className="grid">
            {section.items.map(([id, state]) => (
              <li key={id}>
                <div>
                  {titles.get(id) ?? id}
                  <small className="muted">{id}</small>
                </div>
                <span className={TONE[state] ?? ""}>{state}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
