import { useState } from "react";
import { Link } from "react-router";
import { useInstanceQuery } from "../api";

type Resource = { id: string; region_name: string; account_id: string; resource_type: string };

// ponytail: first rows only per service (IAM alone has 1500 managed policies); paginate if needed
const ROW_LIMIT = 200;

export default function Stack() {
  const { data, error, refetch, isFetching } = useInstanceQuery<Record<string, Resource[]>>("/resources", false);
  const [filter, setFilter] = useState("");

  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;

  const wanted = filter.toLowerCase();
  const services: Record<string, Resource[]> = {};
  for (const [type, items] of Object.entries(data)) {
    const shown = items.filter((item) => `${type} ${item.id}`.toLowerCase().includes(wanted));
    if (shown.length) (services[type.split("::")[1] ?? type] ??= []).push(...shown);
  }
  const names = Object.keys(services).sort();

  return (
    <>
      <h1>Stack overview</h1>
      <div className="row">
        <input type="search" aria-label="Filter by type or ID" placeholder="Filter by type or ID" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => refetch()} disabled={isFetching}>Refresh</button>
        <Link to="/resources">Add resources</Link>
      </div>
      <p className="muted">All accounts and regions, including AWS managed defaults.</p>
      {names.length === 0 && <p>No resources match.</p>}
      {names.map((name) => (
        <Service key={name} name={name} items={services[name]} />
      ))}
    </>
  );
}

function Service({ name, items }: { name: string; items: Resource[] }) {
  const [open, setOpen] = useState(false);
  const count = (values: string[]) => new Set(values).size;
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <strong>{name}</strong>{" "}
        <span className="muted">
          resources: {items.length}, types: {count(items.map((i) => i.resource_type))}, regions:{" "}
          {count(items.map((i) => i.region_name))}, accounts: {count(items.map((i) => i.account_id))}
        </span>
      </summary>
      {open && (
        <>
          <table>
            <thead>
              <tr><th>Type</th><th>ID</th><th>Region</th><th>Account</th></tr>
            </thead>
            <tbody>
              {items.slice(0, ROW_LIMIT).map((item) => (
                <tr key={`${item.resource_type}/${item.account_id}/${item.region_name}/${item.id}`}>
                  <td>{item.resource_type}</td><td>{item.id}</td><td>{item.region_name}</td><td>{item.account_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > ROW_LIMIT && (
            <p className="muted">First {ROW_LIMIT} of {items.length} shown. Filter to narrow the list.</p>
          )}
        </>
      )}
    </details>
  );
}
