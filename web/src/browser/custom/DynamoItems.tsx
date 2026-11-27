import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useScope } from "../../api";
import { useAws, useAwsCall, useRefresh } from "../../aws";
import { type AttributeTypes, emptyItem, type Item, itemKey, type KeySchema, plain, queryParams, SORT_OPERATORS } from "../../dynamo";
import { cell } from "../../engine";
import { type Params, parseParams } from "../../params";

type Table = {
  KeySchema: KeySchema;
  AttributeDefinitions: AttributeTypes;
  GlobalSecondaryIndexes?: { IndexName: string; KeySchema: KeySchema }[];
  LocalSecondaryIndexes?: { IndexName: string; KeySchema: KeySchema }[];
};

const PAGE_SIZE = 100;
const MAX_COLUMNS = 8;

export default function DynamoItems({ ids }: { ids: string[] }) {
  const name = ids[0];
  const { data, error } = useAws<{ Table: Table }>("dynamodb", "DescribeTable", { TableName: name });
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  return <Items name={name} table={data.result.Table} />;
}

function Items({ name, table }: { name: string; table: Table }) {
  const instance = useInstance();
  const { region, account } = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const indexes = [...(table.GlobalSecondaryIndexes ?? []), ...(table.LocalSecondaryIndexes ?? [])];
  const [mode, setMode] = useState<"Scan" | "Query">("Scan");
  const [index, setIndex] = useState("");
  const [partition, setPartition] = useState("");
  const [sort, setSort] = useState({ operator: "=", value: "" });
  const [request, setRequest] = useState<{ op: "Scan" | "Query"; params: Params }>({ op: "Scan", params: {} });
  const [token, setToken] = useState<Params>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ title: string; text: string }>();
  const schema = indexes.find((i) => i.IndexName === index)?.KeySchema ?? table.KeySchema;
  const sortName = schema.find((key) => key.KeyType === "RANGE")?.AttributeName;

  const list = useAws<{ Items?: Item[] }>("dynamodb", request.op, {
    TableName: name,
    Limit: PAGE_SIZE,
    ...request.params,
    ...token,
  });
  const items = list.data?.result.Items ?? [];
  const idOf = (item: Item) => JSON.stringify(itemKey(item, table.KeySchema));
  const keyNames = table.KeySchema.map((key) => key.AttributeName);
  const heads = [...new Set([...keyNames, ...items.flatMap(Object.keys)])].slice(0, MAX_COLUMNS);

  const run = (event: FormEvent) => {
    event.preventDefault();
    const params =
      mode === "Scan"
        ? { ...(index && { IndexName: index }) }
        : { ...queryParams(schema, table.AttributeDefinitions, partition, sort), ...(index && { IndexName: index }) };
    setToken(undefined);
    setSelected(new Set());
    setRequest({ op: mode, params });
    refresh();
  };
  const save = useMutation({
    mutationFn: (text: string) => call("dynamodb", "PutItem", { TableName: name, Item: parseParams(text) }),
    onSuccess: () => {
      setEditor(undefined);
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async (keys: string[]) => {
      for (const key of keys) await call("dynamodb", "DeleteItem", { TableName: name, Key: JSON.parse(key) });
    },
    onSettled: () => {
      setSelected(new Set());
      return refresh();
    },
  });
  const confirmRemove = () => {
    const keys = [...selected];
    if (window.confirm(`Delete ${keys.length} items from table "${name}" (${account}, ${region})? This cannot be undone.`)) {
      remove.mutate(keys);
    }
  };
  const expire = useMutation({
    mutationFn: () => api<{ ExpiredItems: number }>(instancePath(instance, "/dynamodb/expired"), "POST"),
    onSuccess: refresh,
  });
  const confirmExpire = () => {
    const warning = `Delete expired items in ALL tables of instance "${instance}"? Items past their time to live are removed. This cannot be undone.`;
    if (window.confirm(warning)) expire.mutate();
  };
  const open = (title: string, item: Item) => {
    save.reset();
    setEditor({ title, text: JSON.stringify(item, null, 2) });
  };
  const error = list.error ?? remove.error ?? expire.error;

  return (
    <>
      <form className="row" onSubmit={run}>
        <select aria-label="Read mode" value={mode} onChange={(e) => setMode(e.target.value as "Scan" | "Query")}>
          <option>Scan</option>
          <option>Query</option>
        </select>
        {indexes.length > 0 && (
          <select aria-label="Index" value={index} onChange={(e) => setIndex(e.target.value)}>
            <option value="">Table</option>
            {indexes.map((i) => (
              <option key={i.IndexName}>{i.IndexName}</option>
            ))}
          </select>
        )}
        {mode === "Query" && (
          <>
            <input aria-label="Partition key value" placeholder={`${schema[0].AttributeName} =`} required value={partition} onChange={(e) => setPartition(e.target.value)} />
            {sortName && (
              <>
                <select aria-label="Sort key operator" value={sort.operator} onChange={(e) => setSort({ ...sort, operator: e.target.value })}>
                  {SORT_OPERATORS.map((operator) => (
                    <option key={operator}>{operator}</option>
                  ))}
                </select>
                <input aria-label="Sort key value" placeholder={`${sortName} (optional)`} value={sort.value} onChange={(e) => setSort({ ...sort, value: e.target.value })} />
              </>
            )}
          </>
        )}
        <button className="primary" disabled={list.isFetching}>Run</button>
      </form>
      <div className="row">
        <button onClick={() => open("New item", emptyItem(table.KeySchema, table.AttributeDefinitions))}>Add item</button>
        <button className="danger" disabled={selected.size === 0 || remove.isPending} onClick={confirmRemove}>
          Delete selected ({selected.size})
        </button>
        <button onClick={confirmExpire} disabled={expire.isPending}>Delete expired items</button>
        {expire.data && <span role="status">Expired items deleted: {expire.data.ExpiredItems}</span>}
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {editor && (
        <section aria-label="Item editor">
          <h2>{editor.title}</h2>
          <p className="muted">DynamoDB JSON. Saving with changed key values writes a separate item.</p>
          <textarea className="code" aria-label="Item as DynamoDB JSON" rows={14} spellCheck={false} value={editor.text} onChange={(e) => setEditor({ ...editor, text: e.target.value })} />
          <div className="row">
            <button className="primary" disabled={save.isPending} onClick={() => save.mutate(editor.text)}>Save item</button>
            <button onClick={() => setEditor(undefined)}>Cancel</button>
          </div>
          {save.error && <p role="alert" className="bad">{save.error.message}</p>}
        </section>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="check"><span className="sr-only">Select</span></th>
              {heads.map((head) => (
                <th key={head}>{head}</th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, row) => {
              // an index scan may not return the table keys of every item
              const id = idOf(item);
              return (
                <tr key={`${id}/${row}`}>
                  <td className="check">
                    <input type="checkbox" aria-label={`Select item ${id}`} checked={selected.has(id)}
                      onChange={(e) =>
                        setSelected((old) => {
                          const next = new Set(old);
                          if (e.target.checked) next.add(id);
                          else next.delete(id);
                          return next;
                        })} />
                  </td>
                  {heads.map((head) => (
                    <td key={head}>{cell(plain(item[head]))}</td>
                  ))}
                  <td><button onClick={() => open("Edit item", item)}>View or edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.data && items.length === 0 && <p className="muted">No items in this result.</p>}
      {(token || list.data?.next) && (
        <div className="row">
          <button disabled={!token} onClick={() => setToken(undefined)}>First page</button>
          <button disabled={!list.data?.next} onClick={() => setToken(list.data!.next!)}>Next page</button>
        </div>
      )}
    </>
  );
}
