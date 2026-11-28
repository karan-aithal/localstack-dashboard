/** Query editors of Athena and Timestream: run a statement, read its rows. */

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { type Scope, useScope } from "../../api";
import { useAwsCall } from "../../aws";
import S3Picker from "../../components/S3Picker";

type Table = { columns: string[]; rows: string[][]; more: boolean };

type Execution = { QueryExecution: { Status: { State: string; StateChangeReason?: string } } };
type AthenaRows = {
  ResultSet: { ResultSetMetadata?: { ColumnInfo: { Name: string }[] }; Rows: { Data: { VarCharValue?: string }[] }[] };
  NextToken?: string;
};
type TimestreamRows = { ColumnInfo: { Name?: string }[]; Rows: { Data: { ScalarValue?: string }[] }[]; NextToken?: string };

const WAIT_SECONDS = 120;

export function AthenaSql() {
  const call = useAwsCall();
  const [output, setOutput] = useState("");
  const run = async (statement: string, scope: Scope): Promise<Table> => {
    const ask = async <T,>(operation: string, params: Record<string, unknown>) =>
      (await call<T>("athena", operation, params, scope)).result;
    const { QueryExecutionId } = await ask<{ QueryExecutionId: string }>("StartQueryExecution", {
      QueryString: statement,
      ...(output && { ResultConfiguration: { OutputLocation: output } }),
    });
    for (let second = 0; second < WAIT_SECONDS; second++) {
      const { Status } = (await ask<Execution>("GetQueryExecution", { QueryExecutionId })).QueryExecution;
      if (Status.State === "SUCCEEDED") {
        const found = await ask<AthenaRows>("GetQueryResults", { QueryExecutionId });
        const columns = found.ResultSet.ResultSetMetadata?.ColumnInfo.map((c) => c.Name) ?? [];
        const rows = found.ResultSet.Rows.map((row) => row.Data.map((d) => d.VarCharValue ?? ""));
        // the first row of a SELECT repeats the column names
        const heading = rows[0]?.join("\n") === columns.join("\n");
        return { columns, rows: heading ? rows.slice(1) : rows, more: !!found.NextToken };
      }
      if (Status.State === "FAILED" || Status.State === "CANCELLED") {
        throw new Error(`Query ${Status.State.toLowerCase()}. ${Status.StateChangeReason ?? ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`The query is still running. Its execution ID is ${QueryExecutionId}.`);
  };
  return (
    <Editor run={run} example="SELECT 1">
      <label className="field">
        Output location (S3 address, if the workgroup sets none)
        <input value={output} placeholder="s3://bucket/results/" pattern="s3://.+" onChange={(e) => setOutput(e.target.value)} />
      </label>
      <S3Picker onPick={setOutput} />
    </Editor>
  );
}

export function TimestreamQuery() {
  const call = useAwsCall();
  const run = async (statement: string, scope: Scope): Promise<Table> => {
    const found = (await call<TimestreamRows>("timestream-query", "Query", { QueryString: statement }, scope)).result;
    return {
      columns: found.ColumnInfo.map((c, i) => c.Name ?? `column ${i + 1}`),
      // arrays, rows and time series are shown as their JSON
      rows: found.Rows.map((row) => row.Data.map((d) => d.ScalarValue ?? JSON.stringify(d))),
      more: !!found.NextToken,
    };
  };
  return <Editor run={run} example={'SELECT * FROM "database"."table" LIMIT 10'} />;
}

type EditorProps = {
  run: (statement: string, scope: Scope) => Promise<Table>;
  example: string;
  children?: ReactNode;
};

function Editor({ run, example, children }: EditorProps) {
  const scope = useScope();
  const [statement, setStatement] = useState("");
  const query = useMutation({ mutationFn: () => run(statement, scope) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    query.mutate();
  };
  const found = query.data;

  return (
    <>
      <form onSubmit={submit}>
        <textarea className="code" aria-label="Query" rows={6} required spellCheck={false} placeholder={example} value={statement} onChange={(e) => setStatement(e.target.value)} />
        {children}
        <div className="row">
          <button className="primary" disabled={query.isPending}>{query.isPending ? "Running…" : "Run"}</button>
        </div>
      </form>
      {query.error && <p role="alert" className="bad">{query.error.message}</p>}
      {found && found.rows.length === 0 && <p className="muted" role="status">The query returned no rows.</p>}
      {found && found.rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr>{found.columns.map((name, i) => <th key={i}>{name}</th>)}</tr></thead>
            <tbody>
              {found.rows.map((row, i) => (
                <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {found?.more && <p className="muted">Only the first page of rows is shown.</p>}
    </>
  );
}
