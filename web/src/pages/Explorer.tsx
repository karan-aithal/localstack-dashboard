import { useEffect, useRef, useState } from "react";
import { NavLink, useParams } from "react-router";
import { useInstanceQuery } from "../api";
import OperationForm, { useDefinition } from "../components/OperationForm";

type Service = { id: string; title: string; state: string };

export default function Explorer() {
  const { service, operation } = useParams();
  const services = useInstanceQuery<Service[]>("/services", false);
  const operations = useDefinition<{ operations: string[] }>(`/api/aws/${service}`, !!service);
  const error = services.error ?? operations.error;

  return (
    <>
      <h1>Explorer</h1>
      {error && <p role="alert" className="bad">{error.message}</p>}
      <div className="explorer">
        <Picker
          label="Services"
          items={(services.data ?? []).map(({ id, title, state }) => ({
            to: `/explorer/${id}`,
            name: id,
            hint: state === "running" ? `${title} (running)` : title,
          }))}
        />
        {service && (
          <Picker
            key={service}
            label="Operations"
            items={(operations.data?.operations ?? []).map((name) => ({ to: `/explorer/${service}/${name}`, name }))}
          />
        )}
        {service && operation ? (
          <div key={`${service}/${operation}`}>
            <h2 className="operation-title">{service}: {operation}</h2>
            <OperationForm service={service} operation={operation} />
          </div>
        ) : (
          <p className="muted">Pick a service, then an operation.</p>
        )}
      </div>
    </>
  );
}

function Picker({ label, items }: { label: string; items: { to: string; name: string; hint?: string }[] }) {
  const [filter, setFilter] = useState("");
  const wanted = filter.toLowerCase();
  const shown = items.filter(({ name, hint }) => `${name} ${hint ?? ""}`.toLowerCase().includes(wanted));
  const list = useRef<HTMLUListElement>(null);
  // a deep link may select an entry far down the list: bring it into view once the list has loaded
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [items.length]);
  return (
    <section className="picker" aria-label={label}>
      <input type="search" aria-label={`Filter ${label.toLowerCase()}`} placeholder={`Filter ${label.toLowerCase()}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul ref={list}>
        {shown.map(({ to, name, hint }) => (
          <li key={to}>
            {/* a service stays selected while one of its operations is open */}
            <NavLink to={to}>
              {name}
              {hint && <small>{hint}</small>}
            </NavLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
