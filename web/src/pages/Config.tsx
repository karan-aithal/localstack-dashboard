import { useState } from "react";
import { useInstanceQuery } from "../api";

type Data = { enabled: boolean; values: Record<string, unknown> };

export default function Config() {
  const { data, error } = useInstanceQuery<Data>("/config", 30000);
  const [filter, setFilter] = useState("");

  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;

  const rows = Object.entries(data.values)
    .filter(([key]) => key.toLowerCase().includes(filter.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <h1>Config</h1>
      {!data.enabled ? (
        <p>
          This instance does not expose its configuration. Set <code>ENABLE_CONFIG_UPDATES=1</code> in the
          container environment and recreate it. Recreating loses state that is not persisted.
        </p>
      ) : (
        <>
          <div className="row">
            <input type="search" aria-label="Filter settings" placeholder="Filter settings" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <table>
            <thead><tr><th>Setting</th><th>Value</th></tr></thead>
            <tbody>
              {rows.map(([key, value]) => (
                <tr key={key}>
                  <th scope="row">{key}</th>
                  <td>{typeof value === "string" ? value : JSON.stringify(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
