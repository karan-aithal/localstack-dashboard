import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { useAws, useAwsCall, useRefresh } from "../../aws";
import { href } from "../../engine";
import type { Params } from "../../params";

type Parameter = { ParameterKey: string; DefaultValue?: string; ParameterValue?: string; Description?: string; NoEcho?: boolean };
type Stacks = { Stacks: { Parameters?: Parameter[] }[] };

/** Create a stack, or update the one in `ids`. */
export default function StackEditor({ ids }: { ids: string[] }) {
  const name = ids[0];
  return name ? <Update name={name} /> : <Editor />;
}

function Update({ name }: { name: string }) {
  const template = useAws<{ TemplateBody: unknown }>("cloudformation", "GetTemplate", { StackName: name });
  const stack = useAws<Stacks>("cloudformation", "DescribeStacks", { StackName: name });
  const error = template.error ?? stack.error;
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!template.data || !stack.data) return <p>Loading…</p>;
  const body = template.data.result.TemplateBody;
  return (
    <Editor
      name={name}
      current={typeof body === "string" ? body : JSON.stringify(body, null, 2)}
      previous={stack.data.result.Stacks[0]?.Parameters ?? []}
    />
  );
}

function Editor({ name, current = "", previous = [] }: { name?: string; current?: string; previous?: Parameter[] }) {
  const call = useAwsCall();
  const refresh = useRefresh();
  const [stackName, setStackName] = useState(name ?? "");
  const [source, setSource] = useState<"body" | "url">("body");
  const [body, setBody] = useState(current);
  const [url, setUrl] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState(false);
  const template = (): Params => (source === "body" ? { TemplateBody: body } : { TemplateURL: url });
  const check = useMutation({
    mutationFn: async () => (await call<{ Parameters?: Parameter[] }>("cloudformation", "ValidateTemplate", template())).result.Parameters ?? [],
  });
  const deploy = useMutation({
    mutationFn: async () => {
      // an empty field keeps the previous value on update, and the template default on create
      const parameters = (check.data ?? previous).flatMap(({ ParameterKey }): Params[] => {
        const value = values[ParameterKey];
        if (value) return [{ ParameterKey, ParameterValue: value }];
        return previous.some((p) => p.ParameterKey === ParameterKey) ? [{ ParameterKey, UsePreviousValue: true }] : [];
      });
      const { result } = await call<{ StackId: string }>("cloudformation", name ? "UpdateStack" : "CreateStack", {
        StackName: stackName,
        ...template(),
        ...(parameters.length && { Parameters: parameters }),
        ...(capabilities && { Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"] }),
      });
      return result.StackId;
    },
    onSuccess: refresh,
  });
  const parameters = check.data ?? previous;
  const edit = (change: () => void) => {
    // parameters found for an earlier template no longer apply
    check.reset();
    change();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    deploy.mutate();
  };

  return (
    <form onSubmit={submit}>
      <label className="field">Stack name *<input required value={stackName} readOnly={!!name} onChange={(e) => setStackName(e.target.value)} pattern="[A-Za-z][A-Za-z0-9\-]*" /></label>
      <fieldset>
        <legend>Template</legend>
        <label className="choice"><input type="radio" name="template" checked={source === "body"} onChange={() => edit(() => setSource("body"))} />Paste or choose a file</label>
        <label className="choice"><input type="radio" name="template" checked={source === "url"} onChange={() => edit(() => setSource("url"))} />S3 URL</label>
        {source === "body" ? (
          <>
            <input type="file" aria-label="Template file" accept=".json,.yaml,.yml,.template" onChange={(e) => e.target.files?.[0]?.text().then((text) => edit(() => setBody(text)))} />
            <textarea className="code" aria-label="Template" rows={14} required spellCheck={false} value={body} onChange={(e) => edit(() => setBody(e.target.value))} />
          </>
        ) : (
          <input aria-label="Template URL" type="url" required size={60} value={url} onChange={(e) => edit(() => setUrl(e.target.value))} />
        )}
      </fieldset>
      <div className="row">
        <button type="button" disabled={check.isPending || !(source === "body" ? body : url)} onClick={() => check.mutate()}>
          Check template and read parameters
        </button>
        {check.data && <span role="status" className="good">Valid. Parameters: {check.data.length}</span>}
      </div>
      {parameters.map((parameter) => (
        <label className="field" key={parameter.ParameterKey}>
          {parameter.ParameterKey}
          <input
            type={parameter.NoEcho ? "password" : "text"}
            placeholder={parameter.ParameterValue ?? parameter.DefaultValue ?? ""}
            value={values[parameter.ParameterKey] ?? ""}
            onChange={(e) => setValues({ ...values, [parameter.ParameterKey]: e.target.value })}
          />
          {parameter.Description && <small className="muted">{parameter.Description}</small>}
        </label>
      ))}
      <label className="choice"><input type="checkbox" checked={capabilities} onChange={(e) => setCapabilities(e.target.checked)} />Allow the template to create IAM resources and use macros</label>
      <div className="row">
        <button className="primary" disabled={deploy.isPending}>{name ? "Update stack" : "Create stack"}</button>
      </div>
      {(check.error ?? deploy.error) && <p role="alert" className="bad">{(check.error ?? deploy.error)!.message}</p>}
      {deploy.data && (
        <p role="status" className="good">
          Started. <Link to={href("cloudformation", "stacks", [stackName, "events"])}>Follow the events</Link>
        </p>
      )}
    </form>
  );
}
