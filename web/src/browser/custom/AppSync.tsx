/** AppSync: read and replace the GraphQL schema of an API, and send it queries. */

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useScope } from "../../api";
import { useAws, useAwsCall, useRefresh } from "../../aws";
import { Json } from "../../components/OperationForm";
import { encodeText, parseParams } from "../../params";

export function Query({ ids }: { ids: string[] }) {
  const apiId = ids[0];
  const instance = useInstance();
  const scope = useScope();
  const refresh = useRefresh();
  // a local API key is its own ID
  const keys = useAws<{ apiKeys?: { id: string; description?: string }[] }>("appsync", "ListApiKeys", { apiId });
  const [query, setQuery] = useState("");
  const [variables, setVariables] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [authorization, setAuthorization] = useState("");
  const key = chosen ?? keys.data?.result.apiKeys?.[0]?.id ?? "";
  const run = useMutation({
    mutationFn: async () =>
      api<{ status: number; result: unknown }>(instancePath(instance, `/appsync/${encodeURIComponent(apiId)}/query`), "POST", {
        query,
        variables: variables.trim() ? parseParams(variables) : {},
        api_key: key || null,
        authorization: authorization || null,
        ...scope,
      }),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (/\bmutation\b/.test(query) && !window.confirm("Send this mutation? It can change data.")) return;
    run.mutate();
  };

  return (
    <>
      <form onSubmit={submit}>
        <textarea className="code" aria-label="GraphQL query" rows={10} required spellCheck={false} placeholder="query { __typename }" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="field">
          Variables (JSON object)
          <textarea className="code" rows={3} spellCheck={false} placeholder="{}" value={variables} onChange={(e) => setVariables(e.target.value)} />
        </label>
        <label className="field">
          API key
          <select value={key} onChange={(e) => setChosen(e.target.value)}>
            <option value="">None</option>
            {keys.data?.result.apiKeys?.map((k) => (
              <option key={k.id} value={k.id}>{k.description ? `${k.description} (${k.id})` : k.id}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Authorization header, for other kinds of sign-in
          <input type="password" autoComplete="off" value={authorization} onChange={(e) => setAuthorization(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={run.isPending}>{run.isPending ? "Running…" : "Run"}</button>
        </div>
      </form>
      {keys.error && <p role="alert" className="bad">{keys.error.message}</p>}
      {run.error && <p role="alert" className="bad">{run.error.message}</p>}
      {run.data && (
        <section aria-label="Response">
          <p className="muted" role="status">HTTP {run.data.status}</p>
          <Json value={run.data.result} />
        </section>
      )}
    </>
  );
}

export default function Schema({ ids }: { ids: string[] }) {
  const apiId = ids[0];
  const scope = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const current = useAws<{ schema: { text?: string } }>("appsync", "GetIntrospectionSchema", { apiId, format: "SDL" });
  // unset until edited, so that the editor shows what the instance holds
  const [draft, setDraft] = useState<string>();
  const text = draft ?? current.data?.result.schema.text ?? "";
  const upload = useMutation({
    mutationFn: () => call("appsync", "StartSchemaCreation", { apiId, definition: encodeText(text) }, scope),
    onSuccess: refresh,
  });
  const status = useAws<{ status: string; details?: string }>("appsync", "GetSchemaCreationStatus", { apiId }, upload.isSuccess);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (window.confirm("Replace the schema of this API?")) upload.mutate();
  };

  return (
    <>
      {/* an API without a schema answers with an error, which does not stop a first upload */}
      {current.error && <p role="alert" className="bad">{current.error.message}</p>}
      <form onSubmit={submit}>
        <textarea className="code" aria-label="GraphQL schema" rows={18} required spellCheck={false} value={text} onChange={(e) => setDraft(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={upload.isPending || !text}>Save schema</button>
          <button type="button" onClick={() => status.refetch()} disabled={!upload.isSuccess}>Check status</button>
        </div>
      </form>
      {upload.error && <p role="alert" className="bad">{upload.error.message}</p>}
      {status.data && <p role="status">Schema creation: {status.data.result.status}. {status.data.result.details}</p>}
    </>
  );
}
