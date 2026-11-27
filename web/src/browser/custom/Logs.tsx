import { type FormEvent, useState } from "react";
import { useAws } from "../../aws";
import type { Params } from "../../params";

type Events = { events?: { eventId: string; timestamp: number; message: string; logStreamName: string }[] };

const RANGES: [label: string, minutes: number][] = [
  ["All time", 0],
  ["Last 5 minutes", 5],
  ["Last hour", 60],
  ["Last 24 hours", 1440],
];

/** Events of a whole log group (one id) or of one stream (two ids). */
export default function LogEvents({ ids }: { ids: string[] }) {
  const [group, stream] = ids;
  const [pattern, setPattern] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [search, setSearch] = useState<Params>({});
  const [token, setToken] = useState<Params>();
  const { data, error, refetch, isFetching } = useAws<Events>("logs", "FilterLogEvents", {
    logGroupName: group,
    ...(stream && { logStreamNames: [stream] }),
    limit: 200,
    ...search,
    ...token,
  });
  const events = data?.result.events ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setToken(undefined);
    setSearch({
      ...(pattern && { filterPattern: pattern }),
      ...(minutes && { startTime: Date.now() - minutes * 60_000 }),
    });
    // the same search again must still read new events
    refetch();
  };

  return (
    <>
      <form className="row" onSubmit={submit}>
        <input aria-label="Filter pattern" placeholder='Filter pattern, for example "ERROR"' value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <select aria-label="Time range" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {RANGES.map(([label, value]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button className="primary" disabled={isFetching}>Search</button>
        <span className="muted" role="status">{isFetching ? "Loading…" : `${events.length} events`}</span>
      </form>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data && events.length === 0 && <p className="muted">No events match.</p>}
      {events.length > 0 && (
        <div className="scroll">
          <table className="events">
            <thead><tr><th>Time (UTC)</th>{!stream && <th>Stream</th>}<th>Message</th></tr></thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td>{new Date(event.timestamp).toISOString().replace("T", " ").replace("Z", "")}</td>
                  {!stream && <td>{event.logStreamName}</td>}
                  <td className="lines code">{event.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(token || data?.next) && (
        <div className="row">
          <button disabled={!token} onClick={() => setToken(undefined)}>First page</button>
          <button disabled={!data?.next} onClick={() => setToken(data!.next!)}>Next page</button>
        </div>
      )}
    </>
  );
}
