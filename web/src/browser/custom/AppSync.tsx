/** The GraphQL schema of an AppSync API: read it, replace it. */

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useScope } from "../../api";
import { useAws, useAwsCall, useRefresh } from "../../aws";
import { encodeText } from "../../params";

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
