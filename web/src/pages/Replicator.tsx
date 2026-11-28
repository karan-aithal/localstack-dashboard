/** Replicator: have the instance copy a resource from a real AWS account into itself. */

import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery, useScope } from "../api";
import { Json } from "../components/OperationForm";

type Job = { job_id: string; state?: string; type?: string; error_message?: string };
type Supported = { resource_type: string; service: string; single?: { identifier?: string | null; policy_statements?: string[] } };

export default function Replicator() {
  const instance = useInstance();
  const { region } = useScope();
  const jobs = useInstanceQuery<Job[]>("/replicator/jobs");
  const supported = useInstanceQuery<Supported[]>("/replicator/resources", false);
  const [type, setType] = useState("SINGLE_RESOURCE");
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: string }>({});

  // credentials stay in the form: not in component state, a query cache or the browser's storage
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState({});
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? "").trim() || undefined;
    const resource = { resource_arn: text("arn"), resource_type: text("resource_type"), resource_identifier: text("identifier") };
    const named = Object.values(resource).some(Boolean);
    const byArn = !!resource.resource_arn && !resource.resource_type && !resource.resource_identifier;
    const byPair = !resource.resource_arn && !!resource.resource_type && !!resource.resource_identifier;
    if ((named || type === "SINGLE_RESOURCE") && !byArn && !byPair) {
      return setState({ error: "Give either the ARN, or both the type and the identifier." });
    }
    const key = text("key");
    const warning = `Send these AWS credentials to instance "${instance}" and read from the AWS account they belong to?`;
    if (!window.confirm(warning)) return;
    setState({ busy: true });
    try {
      const started = await api<Job[]>(instancePath(instance, "/replicator/jobs"), "POST", {
        replication_type: type,
        source_aws_config: {
          aws_access_key_id: key,
          aws_secret_access_key: text("secret"),
          aws_session_token: text("token"),
          region_name: text("region"),
        },
        replication_job_config: named ? resource : undefined,
      });
      form.reset();
      setState({ done: `Job submitted: ${started.map((j) => j.job_id).join(", ")}` });
      jobs.refetch();
    } catch (error) {
      setState({ error: (error as Error).message });
    }
  };
  const failure = jobs.error ?? supported.error;

  return (
    <>
      <h1>Replicator</h1>
      <p className="warn">
        This reads a real AWS account. Use short-lived credentials limited to reading the resource. The dashboard hands
        them to your instance and does not store them; the instance receives them in full.
      </p>
      {failure && <p role="alert" className="bad">{failure.message}</p>}

      <h2>New job</h2>
      <form onSubmit={submit} autoComplete="off">
        <label className="field">
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="SINGLE_RESOURCE">SINGLE_RESOURCE</option>
            <option value="MOCK">MOCK (test run, copies nothing)</option>
          </select>
        </label>
        <fieldset>
          <legend>Resource: the ARN, or type and identifier</legend>
          <label className="field">ARN<input name="arn" size={60} placeholder="arn:aws:iam::123456789012:role/name" /></label>
          <label className="field">
            Resource type
            <input name="resource_type" list="resource-types" size={40} placeholder="AWS::IAM::Role" />
          </label>
          <datalist id="resource-types">
            {supported.data?.map((s) => <option key={s.resource_type} value={s.resource_type} />)}
          </datalist>
          <label className="field">Identifier<input name="identifier" size={40} /></label>
        </fieldset>
        <fieldset>
          <legend>Source AWS credentials</legend>
          <label className="field">Access key ID<input name="key" required pattern="[A-Za-z0-9]{1,128}" autoComplete="off" /></label>
          <label className="field">Secret access key<input name="secret" type="password" required autoComplete="new-password" /></label>
          <label className="field">Session token (if temporary)<input name="token" type="password" autoComplete="new-password" /></label>
          <label className="field">Region<input name="region" required defaultValue={region} pattern="[a-z0-9\-]+" /></label>
        </fieldset>
        <button className="primary" disabled={state.busy}>Start replication</button>
      </form>
      {state.error && <p role="alert" className="bad">{state.error}</p>}
      {state.done && <p role="status" className="good">{state.done}</p>}

      <h2>Jobs</h2>
      {jobs.data?.length === 0 && <p className="muted">No jobs.</p>}
      {jobs.data?.map((job) => (
        <details key={job.job_id}>
          <summary>
            {job.job_id}: <span className={job.error_message ? "bad" : undefined}>{job.state}</span> <span className="muted">{job.type}</span>
          </summary>
          <Json value={job} />
        </details>
      ))}

      <h2>Supported resources</h2>
      {supported.data && (
        <div className="scroll">
          <table>
            <thead><tr><th>Resource type</th><th>Service</th><th>Identifier</th><th>Permissions needed</th></tr></thead>
            <tbody>
              {supported.data.map((s) => (
                <tr key={s.resource_type}>
                  <td>{s.resource_type}</td>
                  <td>{s.service}</td>
                  <td>{s.single?.identifier}</td>
                  <td>{s.single?.policy_statements?.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
