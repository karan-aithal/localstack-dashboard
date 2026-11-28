/** IAM: the policies the instance derives from calls, permission checks and enforcement. */

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery, useScope } from "../api";
import { Json } from "../components/OperationForm";

const KEEP = 200;
const TABS = ["Policy stream", "Summary", "Check access", "Enforcement"] as const;

export default function IamPolicies() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Policy stream");
  return (
    <>
      <h1>IAM policies</h1>
      <div className="tabs" role="group" aria-label="Sections">
        {TABS.map((name) => (
          <button key={name} aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>
      {tab === "Policy stream" && <Stream />}
      {tab === "Summary" && <Summary />}
      {tab === "Check access" && <Check />}
      {tab === "Enforcement" && <Enforcement />}
    </>
  );
}

type Entry = {
  resource?: string;
  request?: { service?: string; operation?: string; allowed?: boolean; internal?: boolean };
  policy_document?: unknown;
  error?: string;
};
type Seen = Entry & { id: number; at: string };

function Stream() {
  const instance = useInstance();
  const [on, setOn] = useState(false);
  const [entries, setEntries] = useState<Seen[]>([]);
  const [state, setState] = useState("off");

  useEffect(() => {
    if (!on) return;
    let id = Date.now();
    const source = new EventSource(instancePath(instance, "/iam/stream"));
    const stop = (reason: string) => {
      source.close();
      setState(reason);
      setOn(false);
    };
    source.onopen = () => setState("live");
    source.onmessage = (event) => {
      let entry: Entry;
      try {
        entry = JSON.parse(event.data);
      } catch {
        return;
      }
      if (entry.error) return stop(`failed: ${entry.error}`);
      const seen = { ...entry, id: id++, at: new Date().toLocaleTimeString() };
      setEntries((old) => [seen, ...old].slice(0, KEEP));
    };
    source.addEventListener("end", () => stop("ended"));
    source.onerror = () => stop("disconnected");
    return () => source.close();
  }, [instance, on]);

  return (
    <>
      <p className="muted">
        While the stream is on, each call the instance serves appears here with the policy it would need.
      </p>
      <div className="row">
        <button className="primary" onClick={() => { setState(on ? "off" : "connecting"); setOn(!on); }}>
          {on ? "Stop stream" : "Enable stream"}
        </button>
        <button disabled={entries.length === 0} onClick={() => setEntries([])}>Clear</button>
        <span role="status" className={state === "live" ? "good" : "muted"}>{state}</span>
      </div>
      {entries.length === 0 && <p className="muted">{on ? "Waiting for calls." : "Nothing received."}</p>}
      {entries.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Received</th><th>Call</th><th>Allowed</th><th>Principal or resource</th><th>Policy</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.at}</td>
                  <td>{e.request?.service}.{e.request?.operation}{e.request?.internal && <span className="muted"> internal</span>}</td>
                  <td className={e.request?.allowed === false ? "bad" : undefined}>{e.request?.allowed === false ? "no" : "yes"}</td>
                  <td>{e.resource}</td>
                  <td><details><summary>Show</summary><Json value={e.policy_document} /></details></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Policy = { resource: string; policy_type?: string; policy_document: unknown };

function Summary() {
  const { data, error, refetch, isFetching } = useInstanceQuery<Policy[]>("/iam/summary", false);
  return (
    <>
      <p className="muted">One policy per principal or resource, covering the calls the instance has served.</p>
      <div className="row"><button disabled={isFetching} onClick={() => refetch()}>Refresh</button></div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data?.length === 0 && <p className="muted">No policy recorded yet.</p>}
      {data?.map((policy) => (
        <details key={`${policy.resource} ${policy.policy_type}`}>
          <summary>{policy.resource} <span className="muted">{policy.policy_type}</span></summary>
          <button onClick={() => navigator.clipboard.writeText(JSON.stringify(policy.policy_document, null, 2))}>Copy policy</button>
          <Json value={policy.policy_document} />
        </details>
      ))}
    </>
  );
}

type Permission = { action: string; resource: string };
type Answer = { allowed: boolean; status_reason?: string; source_principal?: { arn?: string } } & Record<string, unknown>;

function Check() {
  const instance = useInstance();
  const { region, account } = useScope();
  const [key, setKey] = useState(account);
  const [rows, setRows] = useState<Permission[]>([{ action: "", resource: "" }]);
  const check = useMutation({
    mutationFn: () =>
      api<Answer>(instancePath(instance, "/iam/check"), "POST", { access_key_id: key, region_name: region, required_permissions: rows }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    check.mutate();
  };
  const edit = (index: number, field: keyof Permission, value: string) =>
    setRows((old) => old.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  return (
    <>
      <p className="muted">Ask whether the owner of an access key may do something, in region {region}. Each resource is a full ARN, such as arn:aws:s3:::* for every bucket.</p>
      <form onSubmit={submit}>
        <label className="field">
          Access key ID
          <input required pattern="[A-Za-z0-9_]{1,128}" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {rows.map((row, i) => (
          <div className="row" key={i}>
            <input required aria-label={`Action ${i + 1}`} placeholder="s3:ListBucket" pattern="[A-Za-z0-9\-]+:[A-Za-z0-9*?]+" value={row.action} onChange={(e) => edit(i, "action", e.target.value)} />
            <input required aria-label={`Resource ${i + 1}`} placeholder="arn:aws:s3:::bucket" pattern="arn:[^:]*:[^:]*:[^:]*:[^:]*:.+" size={40} value={row.resource} onChange={(e) => edit(i, "resource", e.target.value)} />
            {rows.length > 1 && <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        <div className="row">
          <button type="button" disabled={rows.length >= 20} onClick={() => setRows([...rows, { action: "", resource: "" }])}>Add action</button>
          <button className="primary" disabled={check.isPending}>Check</button>
        </div>
      </form>
      {check.error && <p role="alert" className="bad">{check.error.message}</p>}
      {check.data && (
        <section aria-label="Result">
          <p role="status" className={check.data.allowed ? "good" : "bad"}>
            {check.data.allowed ? "Allowed" : "Denied"} for {check.data.source_principal?.arn ?? "an unknown principal"}.
          </p>
          {check.data.status_reason && <p>{check.data.status_reason}</p>}
          <details><summary>Full answer</summary><Json value={check.data} /></details>
        </section>
      )}
    </>
  );
}

const STATES = {
  DISABLED: "No policy is evaluated.",
  ENGINE_ONLY: "Policies are evaluated when asked, calls are not restricted.",
  SOFT_MODE: "Calls that would be denied are logged and still served.",
  ENFORCED: "Calls without permission are denied.",
};

type Config = { state: keyof typeof STATES; config_enforce_iam?: boolean; config_iam_soft_mode?: boolean };

function Enforcement() {
  const instance = useInstance();
  const { data, error, refetch } = useInstanceQuery<Config>("/iam/config");
  const [wanted, setWanted] = useState<Config["state"]>();
  const save = useMutation({
    mutationFn: (state: string) => api(instancePath(instance, "/iam/config"), "PUT", { state }),
    onSettled: () => refetch(),
  });
  const chosen = wanted ?? data?.state;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    const warning = `Switch IAM of instance "${instance}" to ${chosen}? ${STATES[chosen]} This affects everything that uses the instance.`;
    if (window.confirm(warning)) save.mutate(chosen, { onSuccess: () => setWanted(undefined) });
  };
  const failure = error ?? save.error;

  return (
    <>
      {failure && <p role="alert" className="bad">{failure.message}</p>}
      {data && chosen && (
        <form onSubmit={submit}>
          <p>Current state: <strong>{data.state}</strong>. {STATES[data.state]}</p>
          <label className="field">
            State
            <select value={chosen} onChange={(e) => setWanted(e.target.value as Config["state"])}>
              {Object.keys(STATES).map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <p className="muted">{STATES[chosen]} A restart returns to the setting the instance was started with.</p>
          <button className="primary" disabled={chosen === data.state || save.isPending}>Apply</button>
        </form>
      )}
    </>
  );
}
