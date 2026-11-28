/** Form for any AWS operation, generated from its input definition, with the response below. */

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { api, type Scope, useInstance, useScope } from "../api";
import { readBase64, type Result, useAwsCall, useRefresh } from "../aws";
import {
  decodeText,
  encodeText,
  type Field,
  isDestructive,
  NUMBERS,
  type Params,
  parseParams,
  takesS3,
  toParams,
  toValues,
  type Values,
} from "../params";
import S3Picker from "./S3Picker";

type Spec = { documentation: string; fields: Field[] };
type Run = Scope & { params: Params; token?: Params };

type Props = {
  service: string;
  operation: string;
  /** values to start with; entries the operation does not take are ignored */
  initial?: Params;
  submitLabel?: string;
};

/** botocore definitions never change while the app is open */
export const useDefinition = <T,>(path: string, enabled = true) =>
  useQuery({ queryKey: ["definition", path], queryFn: () => api<T>(path), staleTime: Infinity, enabled });

export default function OperationForm(props: Props) {
  const spec = useDefinition<Spec>(`/api/aws/${props.service}/${props.operation}`);
  if (spec.error) return <p role="alert" className="bad">{spec.error.message}</p>;
  if (!spec.data) return <p>Loading…</p>;
  return <Form {...props} spec={spec.data} />;
}

function Form({ service, operation, initial = {}, submitLabel = "Send", spec }: Props & { spec: Spec }) {
  const { fields, documentation } = spec;
  const instance = useInstance();
  const scope = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const start = () => {
    const types = new Map(fields.map((field) => [field.name, field.type]));
    const known = Object.entries(initial).filter(([name, value]) => types.has(name) && value !== null);
    // some responses hand back a parsed document where the request wants its text, such as a policy
    const asText = known.map(([name, value]) => [
      name,
      types.get(name) === "string" && typeof value === "object" ? JSON.stringify(value, null, 2) : value,
    ]);
    return toValues(Object.fromEntries(asText), fields);
  };
  const [mode, setMode] = useState<"form" | "json">("form");
  const [values, setValues] = useState<Values>(start);
  const [json, setJson] = useState("{}");
  const [problem, setProblem] = useState("");
  const run = useMutation({
    mutationFn: ({ params, token, region, account }: Run) =>
      call(service, operation, { ...params, ...token }, { region, account }),
    onSuccess: refresh,
  });

  const attempt = (action: () => void) => {
    try {
      setProblem("");
      action();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };
  const switchMode = (next: "form" | "json") =>
    attempt(() => {
      if (next === mode) return;
      if (next === "json") setJson(JSON.stringify(toParams(values, fields), null, 2));
      else setValues(toValues(parseParams(json), fields));
      setMode(next);
    });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    attempt(() => {
      const params = mode === "json" ? parseParams(json) : toParams(values, fields);
      const warning = `Run ${operation} on instance "${instance}" (${scope.account}, ${scope.region})? This can delete data.`;
      if (isDestructive(operation) && !window.confirm(warning)) return;
      run.mutate({ params, ...scope });
    });
  };
  const reset = () => {
    setValues(start());
    setJson(JSON.stringify(toParams(start(), fields), null, 2));
    setProblem("");
    run.reset();
  };

  // what has to be filled in, or already is, comes first; the rest is folded away
  const main = fields.filter((field) => field.required || field.name in initial);
  const optional = fields.filter((field) => !main.includes(field));
  const input = (field: Field) => (
    <FieldInput
      key={field.name}
      id={`${operation}-${field.name}`}
      field={field}
      value={values[field.name] ?? ""}
      onChange={(value) => setValues((old) => ({ ...old, [field.name]: value }))}
    />
  );

  return (
    <div className="operation">
      {documentation && <p className="muted">{documentation}</p>}
      <div className="row" role="group" aria-label="Input mode">
        <button type="button" aria-pressed={mode === "form"} onClick={() => switchMode("form")}>Form</button>
        <button type="button" aria-pressed={mode === "json"} onClick={() => switchMode("json")}>JSON</button>
      </div>
      <form onSubmit={submit}>
        {mode === "json" ? (
          <textarea className="code" aria-label={`${operation} parameters as JSON`} rows={14} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} />
        ) : fields.length === 0 ? (
          <p className="muted">No parameters.</p>
        ) : (
          <>
            {main.map(input)}
            {optional.length > 0 && (
              <details open={main.length === 0}>
                <summary>Optional parameters ({optional.length})</summary>
                {optional.map(input)}
              </details>
            )}
          </>
        )}
        {problem && <p role="alert" className="bad">{problem}</p>}
        <div className="row">
          <button className={isDestructive(operation) ? "danger" : "primary"} disabled={run.isPending}>
            {run.isPending ? "Sending…" : submitLabel}
          </button>
          <button type="button" onClick={reset}>Reset form</button>
        </div>
      </form>

      {run.error && <p role="alert" className="bad">{run.error.message}</p>}
      {run.data && run.variables && (
        <Response
          data={run.data}
          scope={run.variables}
          following={!!run.variables.token}
          onNext={() => run.mutate({ ...run.variables!, token: run.data!.next! })}
        />
      )}
    </div>
  );
}

function Response({ data, scope, following, onNext }: { data: Result; scope: Scope; following: boolean; onNext: () => void }) {
  return (
    <section aria-label="Response">
      <h2>Response</h2>
      <div className="row">
        <span className="muted">
          HTTP {data.status} · {scope.region} · {scope.account}
          {following && " · following page"}
        </span>
        {data.next && <button type="button" onClick={onNext}>Next page</button>}
      </div>
      <Json value={data.result} />
    </section>
  );
}

export const Json = ({ value }: { value: unknown }) => (
  <pre className="response" tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>
);

function FieldInput({ id, field, value, onChange }: { id: string; field: Field; value: string; onChange: (value: string) => void }) {
  const { name, type, required } = field;
  const common = { id, required, value, "aria-describedby": `${id}-help` };
  const options = type === "boolean" ? ["true", "false"] : field.enum;
  const example = JSON.stringify(field.template, null, 2);
  const nested = !["string", "timestamp", "blob", "boolean"].includes(type) && !NUMBERS.has(type);
  const [picked, setPicked] = useState("");
  // inside a nested value the address cannot be placed for the user, so it is copied instead
  const pick = (uri: string) => {
    if (!nested) return onChange(uri);
    navigator.clipboard.writeText(uri).then(
      () => setPicked(`Copied ${uri}. Paste it into the value.`),
      () => setPicked(`Could not copy. The address is ${uri}`),
    );
  };

  return (
    <div className="field">
      <label htmlFor={id}>
        {name}
        {required && " *"} <span className="muted">{type}</span>
      </label>
      {options.length > 0 ? (
        <select {...common} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not set</option>
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : NUMBERS.has(type) ? (
        <input {...common} type="number" step="any" onChange={(e) => onChange(e.target.value)} />
      ) : type === "string" && /password$/i.test(name) ? (
        <input {...common} type="password" autoComplete="new-password" onChange={(e) => onChange(e.target.value)} />
      ) : type === "blob" ? (
        <BlobInput {...common} name={name} onChange={onChange} />
      ) : (
        <textarea
          {...common}
          className={nested ? "code" : undefined}
          rows={nested ? 3 : 1}
          spellCheck={false}
          placeholder={nested ? example : type === "timestamp" ? String(field.template) : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {nested && !value && (
        <button type="button" onClick={() => onChange(example)}>
          Insert example
        </button>
      )}
      {(type === "string" || nested) && takesS3(field) && <S3Picker onPick={pick} />}
      {picked && <span role="status">{picked}</span>}
      <small id={`${id}-help`} className="muted">{field.documentation}</small>
    </div>
  );
}

/** Bytes travel as base64: typed as text, or taken from a file. */
function BlobInput({ name, value, onChange, ...common }: { id: string; name: string; required: boolean; value: string; onChange: (value: string) => void }) {
  const text = useMemo(() => decodeText(value), [value]);
  return (
    <>
      {text === null ? (
        <div className="row">
          <span>Binary content, {Math.ceil((value.length * 3) / 4)} bytes at most</span>
          <button type="button" onClick={() => onChange("")}>Clear</button>
        </div>
      ) : (
        <textarea {...common} rows={3} spellCheck={false} placeholder="Text, or choose a file" value={text} onChange={(e) => onChange(e.target.value ? encodeText(e.target.value) : "")} />
      )}
      <input type="file" aria-label={`${name} from file`} onChange={(e) => e.target.files?.[0] && readBase64(e.target.files[0]).then(onChange)} />
    </>
  );
}
