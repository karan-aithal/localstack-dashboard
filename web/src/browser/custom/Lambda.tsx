import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { useInstanceQuery, useScope } from "../../api";
import { readBase64, useAwsCall, useRefresh } from "../../aws";
import OperationForm from "../../components/OperationForm";
import { href } from "../../engine";
import { decodeText, encodeText, type Params } from "../../params";

const parsed = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

type Invocation = { StatusCode: number; FunctionError?: string; Payload?: { text?: string }; LogResult?: string; ExecutedVersion?: string };

export function Invoke({ ids }: { ids: string[] }) {
  const [name, version] = ids;
  const call = useAwsCall();
  const refresh = useRefresh();
  const [payload, setPayload] = useState("{}");
  const [type, setType] = useState("RequestResponse");
  const invoke = useMutation({
    mutationFn: () => {
      JSON.parse(payload || "null"); // fail here with a clear message rather than in the function
      return call<Invocation>("lambda", "Invoke", {
        FunctionName: name,
        ...(version && { Qualifier: version }),
        InvocationType: type,
        ...(type === "RequestResponse" && { LogType: "Tail" }),
        ...(payload && { Payload: encodeText(payload) }),
      });
    },
    onSuccess: refresh,
  });
  const result = invoke.data?.result;

  return (
    <>
      <div className="field">
        <label htmlFor="payload">Event payload (JSON)</label>
        <textarea id="payload" className="code" rows={8} spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} />
      </div>
      <div className="row">
        <select aria-label="Invocation type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="RequestResponse">Wait for the result</option>
          <option value="Event">Asynchronous</option>
          <option value="DryRun">Dry run</option>
        </select>
        <button className="primary" disabled={invoke.isPending} onClick={() => invoke.mutate()}>
          {invoke.isPending ? "Invoking…" : "Invoke"}
        </button>
      </div>
      {invoke.error && <p role="alert" className="bad">{invoke.error.message}</p>}
      {result && (
        <section aria-label="Invocation result">
          <p className={result.FunctionError ? "bad" : "good"}>
            Status {result.StatusCode}
            {result.FunctionError ? `: function error (${result.FunctionError})` : ""}
            {result.ExecutedVersion && `, version ${result.ExecutedVersion}`}
          </p>
          {result.Payload?.text && (
            <>
              <h2>Response</h2>
              <pre className="response" tabIndex={0}>{parsed(result.Payload.text)}</pre>
            </>
          )}
          {result.LogResult && (
            <>
              <h2>Log tail</h2>
              <pre className="response" tabIndex={0}>{decodeText(result.LogResult)}</pre>
            </>
          )}
        </section>
      )}
    </>
  );
}

type Source = "zip" | "s3" | "hot-reload";

/** Where code comes from. Returns the fields that Lambda expects for the chosen source. */
function useCodeSource(sources: Source[]) {
  const [source, setSource] = useState<Source>("zip");
  const [file, setFile] = useState<File>();
  const [bucket, setBucket] = useState("");
  const [key, setKey] = useState("");

  const read = async (): Promise<Params> => {
    if (source === "zip") {
      if (!file) throw new Error("Choose a zip file");
      return { ZipFile: await readBase64(file) };
    }
    // LocalStack mounts a local directory instead of a package for the bucket "hot-reload"
    return source === "s3" ? { S3Bucket: bucket, S3Key: key } : { S3Bucket: "hot-reload", S3Key: key };
  };
  const labels: Record<Source, string> = { zip: "Upload a zip file", s3: "Object in S3", "hot-reload": "Hot reload from a local folder" };
  const input = (
    <fieldset>
      <legend>Code</legend>
      {sources.map((option) => (
        <label key={option} className="choice">
          <input type="radio" name="source" checked={source === option} onChange={() => { setSource(option); setKey(""); }} />
          {labels[option]}
        </label>
      ))}
      {source === "zip" && <input type="file" aria-label="Zip file" accept=".zip" required onChange={(e) => setFile(e.target.files?.[0])} />}
      {source === "s3" && (
        <>
          <input aria-label="Bucket" placeholder="Bucket" required value={bucket} onChange={(e) => setBucket(e.target.value)} />
          <input aria-label="Object key" placeholder="Object key" required value={key} onChange={(e) => setKey(e.target.value)} />
        </>
      )}
      {source === "hot-reload" && (
        <input aria-label="Absolute folder path on this machine" placeholder="/absolute/path/to/code" required pattern="\/.*" value={key} onChange={(e) => setKey(e.target.value)} />
      )}
    </fieldset>
  );
  return { input, read };
}

const useRuntimes = () => useInstanceQuery<string[]>("/lambda/runtimes", false).data ?? [];

const fields = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
};

export function CreateFunction() {
  const { account } = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const runtimes = useRuntimes();
  const code = useCodeSource(["zip", "s3", "hot-reload"]);
  const create = useMutation({
    mutationFn: async (values: Record<string, string>) =>
      call("lambda", "CreateFunction", {
        FunctionName: values.name,
        Runtime: values.runtime,
        Handler: values.handler,
        Role: values.role,
        Timeout: Number(values.timeout),
        MemorySize: Number(values.memory),
        Code: await code.read(),
      }),
    onSuccess: refresh,
  });

  return (
    <form onSubmit={(e) => create.mutate(fields(e))}>
      <label className="field">Function name *<input name="name" required /></label>
      <label className="field">
        Runtime *
        {/* remounted once the runtimes arrive, so that the default applies */}
        <select name="runtime" required key={runtimes.length} defaultValue="python3.13">
          {runtimes.map((runtime) => (
            <option key={runtime}>{runtime}</option>
          ))}
        </select>
      </label>
      <label className="field">Handler *<input name="handler" required defaultValue="app.handler" /></label>
      <label className="field">Execution role ARN *<input name="role" required size={50} defaultValue={`arn:aws:iam::${account}:role/lambda-role`} /></label>
      <label className="field">Timeout in seconds<input name="timeout" type="number" min={1} max={900} defaultValue={3} /></label>
      <label className="field">Memory in MB<input name="memory" type="number" min={128} max={10240} defaultValue={128} /></label>
      {code.input}
      <p className="muted">For other settings, use CreateFunction in the explorer.</p>
      <button className="primary" disabled={create.isPending}>{create.isPending ? "Creating…" : "Submit"}</button>
      {create.error && <p role="alert" className="bad">{create.error.message}</p>}
      {create.data && (
        <p role="status" className="good">
          Created. <Link to={href("lambda", "functions", [String(create.data.result.FunctionName), "configuration"])}>Open the function</Link>
        </p>
      )}
    </form>
  );
}

const WEB_ROLE = "dashboard-web-function-role";
/** Lets Lambda use the role. The role gets no permissions. */
const LAMBDA_TRUST = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

/** For something that may be left from an earlier run. */
const unless = (code: string) => (error: Error) => {
  if (!error.message.startsWith(code)) throw error;
};

/** Create a web function from the Hello World package, or from the reader's own with the full form. */
export function CreateWebFunction() {
  const scope = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const template = useInstanceQuery<{ code: string; zip: string }>("/lambda/hello-web", false);
  const bucket = `dashboard-web-functions-${scope.account}-${scope.region}`;
  const ownRole = `arn:aws:iam::${scope.account}:role/${WEB_ROLE}`;
  const create = useMutation({
    mutationFn: async (values: Record<string, string>) => {
      const ask = <T,>(service: string, operation: string, params: Params) => call<T>(service, operation, params, scope);
      // a role the reader names is theirs: never created or changed here
      if (values.role === ownRole) {
        await ask("iam", "CreateRole", { RoleName: WEB_ROLE, AssumeRolePolicyDocument: LAMBDA_TRUST }).catch(unless("EntityAlreadyExists"));
      }
      await ask("s3", "CreateBucket", {
        Bucket: bucket,
        ...(scope.region !== "us-east-1" && { CreateBucketConfiguration: { LocationConstraint: scope.region } }),
      }).catch(unless("BucketAlreadyOwnedByYou"));
      // AWS asks for the package to be an object version
      await ask("s3", "PutBucketVersioning", { Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } });
      const key = `${values.name}.zip`;
      const { result } = await ask<{ VersionId?: string }>("s3", "PutObject", { Bucket: bucket, Key: key, Body: template.data!.zip });
      await ask("lambda-web", "CreateWebFunction", {
        functionName: values.name,
        revisionConfig: {
          buildConfig: {
            codeConfig: { s3Object: { bucket, key, ...(result.VersionId && { versionId: result.VersionId }) } },
            runtimeConfig: { runtime: values.runtime },
          },
          serviceConfig: { executionRoleArn: values.role },
        },
        endpointConfig: {
          endpointName: "default",
          endpointType: "HomeRegion",
          authType: "ApplicationManaged",
          autoDeploymentMode: "LatestRevision",
        },
      });
      return values.name;
    },
    onSuccess: refresh,
  });

  return (
    <>
      <form onSubmit={(e) => create.mutate(fields(e))}>
        <h3>Hello World</h3>
        <p className="muted">
          Uploads the code below to the bucket {bucket}, then creates the function with an endpoint named "default". The endpoint does not check
          who calls it. If the role below is left as it is and missing, it is created without any permissions.
        </p>
        <label className="field">Function name *<input name="name" required maxLength={64} pattern="[A-Za-z0-9]([A-Za-z0-9_\-]*[A-Za-z0-9])?" /></label>
        <label className="field">
          Runtime *
          <select name="runtime">
            <option>nodejs24.x</option>
            <option>nodejs26.x</option>
          </select>
        </label>
        <label className="field">Execution role ARN *<input name="role" required size={50} key={ownRole} defaultValue={ownRole} /></label>
        {template.data && (
          <details>
            <summary>index.js</summary>
            <pre className="response" tabIndex={0}>{template.data.code}</pre>
          </details>
        )}
        {template.error && <p role="alert" className="bad">{template.error.message}</p>}
        <button className="primary" disabled={!template.data || create.isPending}>{create.isPending ? "Creating…" : "Create Hello World"}</button>
        {create.error && <p role="alert" className="bad">{create.error.message}</p>}
        {create.data && (
          <p role="status" className="good">
            Created. <Link to={href("lambda", "web-functions", [create.data, "endpoints"])}>See its endpoint</Link>
          </p>
        )}
      </form>
      <details>
        <summary>Create with your own code</summary>
        <OperationForm service="lambda-web" operation="CreateWebFunction" />
      </details>
    </>
  );
}

export function PublishLayer() {
  const call = useAwsCall();
  const refresh = useRefresh();
  const runtimes = useRuntimes();
  const code = useCodeSource(["zip", "s3"]);
  const publish = useMutation({
    mutationFn: async ({ values, chosen }: { values: Record<string, string>; chosen: string[] }) =>
      call("lambda", "PublishLayerVersion", {
        LayerName: values.name,
        Description: values.description,
        ...(chosen.length && { CompatibleRuntimes: chosen }),
        Content: await code.read(),
      }),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const chosen = new FormData(event.currentTarget).getAll("runtimes").map(String);
    publish.mutate({ values: fields(event), chosen });
  };

  return (
    <form onSubmit={submit}>
      <label className="field">Layer name *<input name="name" required /></label>
      <label className="field">Description<input name="description" size={50} /></label>
      <label className="field">
        Compatible runtimes (up to 15)
        <select name="runtimes" multiple size={8}>
          {runtimes.map((runtime) => (
            <option key={runtime}>{runtime}</option>
          ))}
        </select>
      </label>
      {code.input}
      <button className="primary" disabled={publish.isPending}>{publish.isPending ? "Publishing…" : "Submit"}</button>
      {publish.error && <p role="alert" className="bad">{publish.error.message}</p>}
      {publish.data && <p role="status" className="good">Published version {String(publish.data.result.Version)}.</p>}
    </form>
  );
}
