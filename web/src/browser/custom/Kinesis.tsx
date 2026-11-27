import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useAws, useAwsCall } from "../../aws";
import { decodeText } from "../../params";

type Records = {
  Records: { SequenceNumber: string; PartitionKey: string; ApproximateArrivalTimestamp?: string; Data: string }[];
  NextShardIterator?: string;
};

/** Read a stream shard from its oldest record on. */
export default function KinesisRecords({ ids }: { ids: string[] }) {
  const stream = ids[0];
  const call = useAwsCall();
  const shards = useAws<{ Shards: { ShardId: string }[] }>("kinesis", "ListShards", { StreamName: stream });
  const [chosen, setChosen] = useState("");
  const shard = chosen || shards.data?.result.Shards[0]?.ShardId;
  const read = useMutation({
    mutationFn: async (iterator?: string) => {
      const from =
        iterator ??
        (await call<{ ShardIterator: string }>("kinesis", "GetShardIterator", {
          StreamName: stream,
          ShardId: shard,
          ShardIteratorType: "TRIM_HORIZON",
        })).result.ShardIterator;
      return (await call<Records>("kinesis", "GetRecords", { ShardIterator: from, Limit: 100 })).result;
    },
  });
  const records = read.data?.Records ?? [];
  const error = shards.error ?? read.error;

  return (
    <>
      <div className="row">
        <select aria-label="Shard" value={shard ?? ""} onChange={(e) => { setChosen(e.target.value); read.reset(); }}>
          {shards.data?.result.Shards.map(({ ShardId }) => <option key={ShardId}>{ShardId}</option>)}
        </select>
        <button className="primary" disabled={!shard || read.isPending} onClick={() => read.mutate(undefined)}>Read from the start</button>
        <button disabled={!read.data?.NextShardIterator || read.isPending} onClick={() => read.mutate(read.data!.NextShardIterator)}>Read on</button>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {read.data && records.length === 0 && <p className="muted" role="status">No further records at the moment.</p>}
      {records.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Partition key</th><th>Data</th><th>Arrived</th><th>Sequence number</th></tr></thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.SequenceNumber}>
                  <td>{record.PartitionKey}</td>
                  <td className="lines code">{decodeText(record.Data) ?? `base64: ${record.Data}`}</td>
                  <td>{record.ApproximateArrivalTimestamp}</td>
                  <td>{record.SequenceNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
