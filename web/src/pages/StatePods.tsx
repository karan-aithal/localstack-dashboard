/** Instance state: keep copies on this machine ("local pods"), load them, reset, and look inside. */

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";
import { Json } from "../components/OperationForm";

type Pod = { pod: string; version: number; created?: number; size: number; services?: string };
type Pods = { pods: Pod[]; size: number; folder: string };

const NAME = "[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}";
const MERGES = ["account-region-merge", "overwrite", "service-merge"];

const bytes = (size: number) =>
  Intl.NumberFormat("en", { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 }).format(size / 1000);

const services = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);

export default function StatePods() {
  return (
    <>
      <h1>State</h1>
      <LocalPods />
      <Reset />
      <Persisted />
      <Overview />
      <Remotes />
    </>
  );
}

function LocalPods() {
  const instance = useInstance();
  const list = useQuery({ queryKey: ["pods"], queryFn: () => api<Pods>("/api/pods") });
  const [merge, setMerge] = useState(MERGES[0]);
  const [done, setDone] = useState("");
  // one change at a time: each says what happened when it ends
  const change = useMutation({
    mutationFn: async ({ run, said }: { run: () => Promise<unknown>; said: string }) => {
      setDone("");
      await run();
      return said;
    },
    onSuccess: setDone,
    onSettled: () => list.refetch(),
  });

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pod = String(form.get("pod"));
    const keep = Number(form.get("keep")) || undefined;
    const warning = keep ? `Save pod "${pod}" and delete all but its newest ${keep} versions? Deleted versions cannot be recovered.` : "";
    if (warning && !window.confirm(warning)) return;
    const body = { pod, keep, services: services(String(form.get("services"))) };
    change.mutate({ run: () => api(instancePath(instance, "/pods"), "POST", body), said: `Saved ${pod}.` });
  };
  const upload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pod = String(form.get("pod"));
    const run = async () => {
      const response = await fetch(`/api/pods/${encodeURIComponent(pod)}`, {
        method: "POST",
        headers: { "x-dashboard": "1", "content-type": "application/zip" },
        body: form.get("file"),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null))?.detail;
        throw new Error(typeof detail === "string" ? detail : `Import failed (${response.status})`);
      }
    };
    change.mutate({ run, said: `Imported into ${pod}.` });
  };
  const load = ({ pod, version }: Pod) =>
    window.confirm(`Load version ${version} of "${pod}" into instance "${instance}" with ${merge}? This changes its resources.${merge === "overwrite" ? "\n\nServices in the pod lose what they got since it was saved." : ""}`) &&
    change.mutate({
      run: () => api(instancePath(instance, `/pods/${pod}/${version}/load?merge=${merge}`), "POST"),
      said: `Loaded ${pod} version ${version}.`,
    });
  const remove = ({ pod, version }: Pod) =>
    window.confirm(`Delete version ${version} of "${pod}" from this machine? This cannot be undone.`) &&
    change.mutate({ run: () => api(`/api/pods/${pod}/${version}`, "DELETE"), said: `Deleted ${pod} version ${version}.` });
  const failure = list.error ?? change.error;

  return (
    <>
      <h2>Local pods</h2>
      {list.data && (
        <p className="muted">
          Copies of instance state in {list.data.folder}, {bytes(list.data.size)} in total. They hold your data,
          including secrets.
        </p>
      )}
      <form className="row" onSubmit={save}>
        <input name="pod" aria-label="Pod name" placeholder="Pod name" required pattern={NAME} />
        <input name="services" aria-label="Services to include, comma separated" placeholder="All services" pattern="[a-z0-9, \-]*" />
        <input name="keep" type="number" min={1} max={1000} aria-label="Versions to keep" placeholder="Keep all" />
        <button className="primary" disabled={change.isPending}>Save from instance</button>
      </form>
      <form className="row" onSubmit={upload}>
        <input name="pod" aria-label="Pod name for the imported file" placeholder="Pod name" required pattern={NAME} />
        <input name="file" type="file" accept=".zip,application/zip" aria-label="State export file" required />
        <button disabled={change.isPending}>Import file</button>
      </form>
      {change.isPending && <p role="status">Working. Large states take a while.</p>}
      {done && <p role="status" className="good">{done}</p>}
      {failure && <p role="alert" className="bad">{failure.message}</p>}
      {list.data?.pods.length === 0 && <p className="muted">No local pods.</p>}
      {!!list.data?.pods.length && (
        <>
          <label className="choice">
            Merge strategy for loading
            <select value={merge} onChange={(e) => setMerge(e.target.value)}>
              {MERGES.map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <div className="scroll">
            <table>
              <thead><tr><th>Pod</th><th>Version</th><th>Created</th><th>Services</th><th>Size</th><th>Actions</th></tr></thead>
              <tbody>
                {list.data.pods.map((p) => (
                  <tr key={`${p.pod}/${p.version}`}>
                    <td>{p.pod}</td>
                    <td>{p.version}</td>
                    <td>{p.created ? new Date(p.created * 1000).toLocaleString() : ""}</td>
                    <td>{p.services}</td>
                    <td>{bytes(p.size)}</td>
                    <td className="actions">
                      <button disabled={change.isPending} onClick={() => load(p)}>Load</button>
                      <a className="button" download href={`/api/pods/${p.pod}/${p.version}/download`}>Export</a>
                      <button className="danger" disabled={change.isPending} onClick={() => remove(p)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Reset() {
  const instance = useInstance();
  const [service, setService] = useState("");
  const reset = useMutation({
    mutationFn: (wanted: string) => api(instancePath(instance, "/state/reset"), "POST", wanted ? { service: wanted } : {}),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const what = service ? `all state of ${service}` : "ALL resources and data";
    if (window.confirm(`Delete ${what} in instance "${instance}"? This cannot be undone.`)) reset.mutate(service);
  };
  return (
    <>
      <h2>Reset</h2>
      <form className="row" onSubmit={submit}>
        <input aria-label="Service to reset" placeholder="All services" pattern="[a-z0-9\-]*" value={service} onChange={(e) => setService(e.target.value)} />
        <button className="danger" disabled={reset.isPending}>Reset state</button>
      </form>
      {reset.error && <p role="alert" className="bad">{reset.error.message}</p>}
      {reset.isSuccess && <p role="status" className="good">State of {reset.variables || "all services"} was reset.</p>}
    </>
  );
}

type Result = { service?: string; status?: string; message?: string };

function Persisted() {
  const instance = useInstance();
  const run = useMutation({
    mutationFn: (action: "save" | "load") => api<Result[]>(instancePath(instance, `/state/${action}`), "POST"),
  });
  const start = (action: "save" | "load") => {
    const warning = action === "save"
      ? `Write the state of instance "${instance}" to its volume, replacing what is saved there?`
      : `Load the state saved on the volume of instance "${instance}"? This changes its resources.`;
    if (window.confirm(warning)) run.mutate(action);
  };
  return (
    <>
      <h2>Saved on the instance</h2>
      <div className="row">
        <button disabled={run.isPending} onClick={() => start("save")}>Save state</button>
        <button disabled={run.isPending} onClick={() => start("load")}>Load state</button>
      </div>
      {run.error && <p role="alert" className="bad">{run.error.message}</p>}
      {run.data && (
        <ul>
          {run.data.length === 0 && <li>Nothing to report.</li>}
          {run.data.map((r, i) => (
            <li key={i} className={r.status === "error" ? "bad" : undefined}>{r.service}: {r.status} {r.message}</li>
          ))}
        </ul>
      )}
    </>
  );
}

type Model = Record<string, Record<string, Record<string, unknown>>>;

function Overview() {
  const instance = useInstance();
  const read = useMutation({ mutationFn: () => api<Model>(instancePath(instance, "/state/metamodel")) });
  const [path, setPath] = useState<string[]>([]);
  const model = read.data;
  const accounts = Object.keys(model ?? {});
  const account = path[0] && accounts.includes(path[0]) ? path[0] : accounts[0];
  const kinds = Object.keys(model?.[account] ?? {}).sort();
  const service = path[1] && kinds.includes(path[1]) ? path[1] : kinds[0];
  const regions = Object.keys(model?.[account]?.[service] ?? {}).sort();
  const region = path[2] && regions.includes(path[2]) ? path[2] : regions.includes("us-east-1") ? "us-east-1" : regions[0];
  const choice = (label: string, value: string, options: string[], index: number) => (
    <select aria-label={label} value={value} onChange={(e) => setPath([account, service, region].map((old, i) => (i === index ? e.target.value : old)))}>
      {options.map((option) => <option key={option}>{option}</option>)}
    </select>
  );

  return (
    <>
      <h2>What the state holds</h2>
      <div className="row">
        <button disabled={read.isPending} onClick={() => read.mutate()}>{model ? "Read again" : "Read state"}</button>
        {account && choice("Account", account, accounts, 0)}
        {service && choice("Service", service, kinds, 1)}
        {region && choice("Region", region, regions, 2)}
      </div>
      {read.error && <p role="alert" className="bad">{read.error.message}</p>}
      {model && accounts.length === 0 && <p className="muted">The state is empty.</p>}
      {region && <Json value={model![account][service][region]} />}
    </>
  );
}

type Remote = { name: string; protocols?: string[]; url?: string };

function Remotes() {
  const instance = useInstance();
  const { data, error, refetch } = useInstanceQuery<Remote[]>("/remotes", false);
  const change = useMutation({
    mutationFn: ({ name, body }: { name: string; body?: unknown }) =>
      api(instancePath(instance, `/remotes/${encodeURIComponent(name)}`), body ? "POST" : "DELETE", body),
    onSettled: () => refetch(),
  });
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const url = String(values.get("url"));
    change.mutate(
      { name: String(values.get("name")), body: { url, protocols: [url.split(":")[0]] } },
      { onSuccess: () => form.reset() },
    );
  };
  const failure = error ?? change.error;

  return (
    <>
      <h2>Pod remotes</h2>
      <p className="muted">
        Places the instance knows for storing pods. Saving to or loading from a remote is not offered here: use the
        LocalStack command line.
      </p>
      {failure && <p role="alert" className="bad">{failure.message}</p>}
      {data?.length === 0 && <p className="muted">No remotes.</p>}
      {!!data?.length && (
        <table>
          <thead><tr><th>Name</th><th>Address</th><th>Actions</th></tr></thead>
          <tbody>
            {data.map((remote) => (
              <tr key={remote.name}>
                <td>{remote.name}</td>
                <td>{remote.url}</td>
                <td>
                  <button disabled={change.isPending}
                    onClick={() => window.confirm(`Remove remote "${remote.name}"?`) && change.mutate({ name: remote.name })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row" onSubmit={add}>
        <input name="name" aria-label="Remote name" placeholder="Remote name" required pattern={NAME} />
        <input name="url" aria-label="Remote address, without user or password" placeholder="s3://bucket/path" required pattern="[a-z0-9+.\-]+://[^@\s]+" size={32} />
        <button disabled={change.isPending}>Add remote</button>
      </form>
    </>
  );
}
