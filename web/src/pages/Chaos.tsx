/** Chaos engineering: make AWS calls fail or slow down, and undo it. */

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, type InputHTMLAttributes, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";
import { EXPERIMENTS, type Experiment, type Input, type Rule, template, type Values } from "../chaos";
import type { InstanceMap } from "../main";

type Current = { faults: Rule[]; latency: number };
type Change = { path: string; method: string; body?: unknown };

const NAMES = { pattern: "[A-Za-z0-9_, \\-]+" };

/** Label and limits of each input; the backend checks the same limits. */
const FIELDS: Record<Input, { label: string } & InputHTMLAttributes<HTMLInputElement>> = {
  probability: { label: "Probability (%)", type: "number", min: 1, max: 100 },
  region: { label: "Region", ...NAMES },
  services: { label: "Services, comma separated", ...NAMES },
  regions: { label: "Regions, comma separated", ...NAMES },
  service: { label: "Service, such as s3", pattern: "[A-Za-z0-9_\\-]+" },
  operation: { label: "Operation, such as GetObject", pattern: "[A-Za-z]+" },
  statusCode: { label: "Error status code", type: "number", min: 400, max: 599 },
  code: { label: "Error code, such as SlowDown", pattern: "[A-Za-z0-9]+" },
};

export default function Chaos() {
  const instance = useInstance();
  const { data, error, refetch } = useInstanceQuery<Current>("/chaos");
  const change = useMutation({
    mutationFn: ({ path, method, body }: Change) => api(instancePath(instance, `/chaos${path}`), method, body),
    onSettled: () => refetch(),
  });
  const active = !!data && (data.faults.length > 0 || data.latency > 0);
  const failure = error ?? change.error;

  return (
    <>
      <h1>Chaos engineering</h1>
      <p className="muted">Faults hit every AWS call that matches, including those of this dashboard, until removed.</p>
      {failure && <p role="alert" className="bad">{failure.message}</p>}
      {active && (
        <p role="status" className="warn">
          Chaos is active: {data.faults.length} fault rule{data.faults.length === 1 ? "" : "s"}, {data.latency} ms added latency.
        </p>
      )}

      <h2>Active fault rules</h2>
      {data?.faults.length === 0 && <p className="muted">None.</p>}
      {!!data?.faults.length && (
        <>
          <div className="scroll">
            <table>
              <thead><tr><th>Service</th><th>Region</th><th>Operation</th><th>Probability</th><th>Error</th><th>Actions</th></tr></thead>
              <tbody>
                {data.faults.map((rule) => (
                  <tr key={JSON.stringify(rule)}>
                    <td>{rule.service ?? "all"}</td>
                    <td>{rule.region ?? "all"}</td>
                    <td>{rule.operation ?? "all"}</td>
                    <td>{Math.round((rule.probability ?? 1) * 100)}%</td>
                    <td>{rule.error ? `${rule.error.statusCode ?? ""} ${rule.error.code ?? ""}` : "default"}</td>
                    <td>
                      <button disabled={change.isPending} onClick={() => change.mutate({ path: "/faults/remove", method: "POST", body: [rule] })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button className="primary" disabled={change.isPending} onClick={() => change.mutate({ path: "/faults", method: "DELETE" })}>
              Stop all faults
            </button>
          </div>
        </>
      )}

      <h2>Experiments</h2>
      <ul className="cards">
        {EXPERIMENTS.map((experiment) => (
          <Card key={experiment.title} experiment={experiment} busy={change.isPending}
            run={(rules) => change.mutate({ path: "/faults", method: "POST", body: rules })} />
        ))}
        <Latency current={data?.latency ?? 0} busy={change.isPending}
          set={(latency) => change.mutate({ path: "/latency", method: "PUT", body: { latency } })} />
      </ul>
    </>
  );
}

function Card({ experiment, busy, run }: { experiment: Experiment; busy: boolean; run: (rules: Rule[]) => void }) {
  const instance = useInstance();
  const instances = useQuery({ queryKey: ["instances"], queryFn: () => api<InstanceMap>("/api/instances") });
  const [values, setValues] = useState<Values>(() => ({
    ...(Object.fromEntries(Object.keys(FIELDS).map((name) => [name, ""])) as Values),
    probability: "100",
    ...experiment.defaults,
  }));
  const rules = experiment.rules(values);
  const command = template(instances.data?.[instance]?.endpoint ?? "http://localhost:4566", rules);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const warning = `Run "${experiment.title}" on instance "${instance}"? Matching calls fail until you remove the rules.`;
    if (rules.length && window.confirm(warning)) run(rules);
  };

  return (
    <li>
      <strong>{experiment.title}</strong>
      <span className="muted">{experiment.about}</span>
      <form onSubmit={submit}>
        {experiment.inputs.map((name) => {
          const { label, ...limits } = FIELDS[name];
          const optional = experiment.optional?.includes(name);
          return (
            <label key={name} className="field">
              {label}{optional && " (optional)"}
              <input required={!optional} value={values[name]} onChange={(e) => setValues((old) => ({ ...old, [name]: e.target.value }))} {...limits} />
            </label>
          );
        })}
        <button className="danger" disabled={busy}>Run experiment</button>
      </form>
      <details>
        <summary>Chaos API template</summary>
        <pre className="response" tabIndex={0}>{command}</pre>
        <button onClick={() => navigator.clipboard.writeText(command)}>Copy</button>
      </details>
    </li>
  );
}

function Latency({ current, busy, set }: { current: number; busy: boolean; set: (latency: number) => void }) {
  const instance = useInstance();
  const [wanted, setWanted] = useState(500);
  const apply = () =>
    window.confirm(`Add ${wanted} ms to every AWS call of instance "${instance}"?`) && set(wanted);

  return (
    <li>
      <strong>Latency</strong>
      <span className="muted">Every AWS call takes longer. Now: {current} ms.</span>
      <label className="field">
        Added latency: {wanted} ms
        <input type="range" min={5} max={10000} step={5} value={wanted} onChange={(e) => setWanted(Number(e.target.value))} />
      </label>
      <div className="row">
        <button className="danger" disabled={busy} onClick={apply}>Run experiment</button>
        <button disabled={busy || current === 0} onClick={() => set(0)}>Remove latency</button>
      </div>
    </li>
  );
}
