import { useMutation } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useAws, useAwsCall, useRefresh } from "../../aws";

const TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "PTR", "CAA", "SPF", "SOA"];

type RecordSet = {
  Name: string;
  Type: string;
  TTL?: number;
  SetIdentifier?: string;
  ResourceRecords?: { Value: string }[];
  AliasTarget?: unknown;
};

/** Add a record to a zone, or edit the one named by the second id. */
export default function RecordEditor({ ids }: { ids: string[] }) {
  const [zone, key] = ids;
  return key ? <Existing zone={zone} wanted={JSON.parse(key) as RecordSet} /> : <Editor zone={zone} />;
}

function Existing({ zone, wanted }: { zone: string; wanted: RecordSet }) {
  const { data, error } = useAws<{ ResourceRecordSets: RecordSet[] }>("route53", "ListResourceRecordSets", {
    HostedZoneId: zone,
    StartRecordName: wanted.Name,
    StartRecordType: wanted.Type,
  });
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const record = data.result.ResourceRecordSets.find(
    (r) => r.Name === wanted.Name && r.Type === wanted.Type && r.SetIdentifier === wanted.SetIdentifier,
  );
  if (!record) return <p className="muted">This record no longer exists.</p>;
  if (record.AliasTarget) return <p className="muted">Alias records are edited with ChangeResourceRecordSets in the explorer.</p>;
  return <Editor key={JSON.stringify(record)} zone={zone} record={record} />;
}

function Editor({ zone, record }: { zone: string; record?: RecordSet }) {
  const call = useAwsCall();
  const refresh = useRefresh();
  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      call("route53", "ChangeResourceRecordSets", {
        HostedZoneId: zone,
        ChangeBatch: {
          Changes: [
            {
              Action: record ? "UPSERT" : "CREATE",
              ResourceRecordSet: {
                // settings the form does not show, such as a weight, are kept
                ...record,
                Name: record?.Name ?? values.name,
                Type: record?.Type ?? values.type,
                TTL: Number(values.ttl),
                ResourceRecords: values.values.split("\n").map((line) => line.trim()).filter(Boolean).map((Value) => ({ Value })),
              },
            },
          ],
        },
      }),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
  };

  return (
    <form onSubmit={submit}>
      <label className="field">Record name *<input name="name" required size={50} defaultValue={record?.Name} disabled={!!record} placeholder="www.example.com" /></label>
      <label className="field">
        Type *
        <select name="type" defaultValue={record?.Type ?? "A"} disabled={!!record}>
          {TYPES.map((type) => <option key={type}>{type}</option>)}
        </select>
      </label>
      <label className="field">TTL in seconds *<input name="ttl" type="number" min={0} required defaultValue={record?.TTL ?? 300} /></label>
      <label className="field">
        Values, one per line *
        <textarea name="values" className="code" rows={4} required spellCheck={false} defaultValue={record?.ResourceRecords?.map((r) => r.Value).join("\n")} />
      </label>
      <button className="primary" disabled={save.isPending}>{record ? "Save record" : "Add record"}</button>
      {save.error && <p role="alert" className="bad">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="good">Saved.</p>}
    </form>
  );
}
