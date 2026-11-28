/** The resource browser: pages described by registry.json, plus a few custom views. */

import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useInstanceQuery, useScope } from "../api";
import { useAws, useAwsCall, useRefresh } from "../aws";
import OperationForm, { Json } from "../components/OperationForm";
import { type Call, cell, columns, current, fillLink, getPath, href, label as nameOf, type Node, params, picked, type Row, rowKey, type Service, type Source, title } from "../engine";
import type { Params } from "../params";
import registry from "../registry.json";
import { CUSTOM } from "./custom";

const SERVICES = registry as unknown as Service[];

/** Where a page sits: ids of the selected resources, and the same interleaved with view ids. */
type Place = { service: string; tab: string; api: string; ids: string[]; path: string[] };

function useLicensed() {
  const { data } = useInstanceQuery<{ services: string[] | null }>("/licensed", false);
  // unknown means: let the call itself say what is not covered
  return (name: string) => data?.services?.includes(name) ?? true;
}

export default function Browser() {
  const { service: serviceId, tab: tabId } = useParams();
  const [query] = useSearchParams();
  const licensed = useLicensed();
  const { region, account } = useScope();

  if (!serviceId) return <Landing licensed={licensed} />;
  const service = SERVICES.find((s) => s.id === serviceId);
  const tab = service?.tabs.find((t) => t.id === (tabId ?? service.tabs[0].id));
  if (!service || !tab) return <p>Page not found.</p>;

  const api = tab.service ?? service.service;
  const rest = query.getAll("p");

  return (
    <>
      <h1>{service.title}</h1>
      <nav aria-label="Sections" className="tabs">
        {service.tabs.map((t) => (
          <Link key={t.id} to={href(service.id, t.id)} aria-current={t === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <Breadcrumb service={service} tab={tab} rest={rest} />
      {licensed(api) ? (
        // keyed so that selections and input never carry over to another page or scope
        <NodeView
          key={`${region}/${account}/${tab.id}/${query}`}
          node={tab}
          place={{ service: service.id, tab: tab.id, api, ids: [], path: [] }}
          rest={rest}
          creating={query.has("new")}
        />
      ) : (
        <p className="warn">Not in your plan.</p>
      )}
    </>
  );
}

function Landing({ licensed }: { licensed: (name: string) => boolean }) {
  const [search, setSearch] = useState("");
  const shown = SERVICES.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(shown.map((s) => s.group))];
  return (
    <>
      <h1>Resources</h1>
      <div className="row">
        <input type="search" size={36} aria-label="Which service are you looking for?" placeholder="Which service are you looking for?" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Link to="/stack">All resources of the instance</Link>
      </div>
      <p className="muted">Services not listed here are available in the explorer.</p>
      <div className="groups">
        {groups.map((group) => (
          <section key={group}>
            <h2>{group}</h2>
            <ul>
              {shown.filter((s) => s.group === group).map((s) => (
                <li key={s.id}>
                  <Link to={href(s.id, s.tabs[0].id)}>{s.title}</Link>
                  {!licensed(s.service) && <span className="warn"> Not in your plan</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function Breadcrumb({ service, tab, rest }: { service: Service; tab: Node; rest: string[] }) {
  const crumbs = [
    { label: "Resources", to: "/resources" },
    { label: tab.label, to: href(service.id, tab.id) },
  ];
  let node: Node | undefined = tab;
  for (let i = 0; i < rest.length; i += 2) {
    const views: Node[] = node?.views ?? [];
    node = views.find((v) => v.id === rest[i + 1]) ?? views[0];
    crumbs.push({ label: nameOf(rest[i]), to: href(service.id, tab.id, rest.slice(0, i + 1)) });
    if (i + 2 < rest.length && node) crumbs.push({ label: node.label, to: href(service.id, tab.id, rest.slice(0, i + 2)) });
  }
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        {crumbs.map(({ label, to }) => (
          <li key={to}>
            <Link to={to}>{label}</Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function NodeView({ node, place, rest, creating }: { node: Node; place: Place; rest: string[]; creating: boolean }) {
  const api = node.service ?? place.api;
  const { ids } = place;

  if (node.list) {
    const [id, viewId] = rest;
    if (id === undefined) {
      const here = { ...place, api };
      return creating && node.create ? <Create node={node} place={here} /> : <ListView node={node} place={here} />;
    }
    const views = node.views ?? [];
    const view = views.find((v) => v.id === viewId) ?? views[0];
    if (!view) return <p>Nothing more to show.</p>;
    return (
      <>
        <h2 className="resource">{nameOf(id)}</h2>
        <nav aria-label="Views" className="tabs">
          {views.map((v) => (
            <Link key={v.id} to={v.link ? fillLink(v.link, [...ids, id]) : href(place.service, place.tab, [...place.path, id, v.id])} aria-current={v === view ? "page" : undefined}>
              {v.label}
            </Link>
          ))}
        </nav>
        <NodeView node={view} place={{ ...place, api, ids: [...ids, id], path: [...place.path, id, view.id] }} rest={rest.slice(2)} creating={creating} />
      </>
    );
  }
  if (node.show) {
    const shown = <Show service={api} operation={node.show.op} params={params(node.show, { ids })} />;
    return node.show.reveal ? <Reveal>{shown}</Reveal> : shown;
  }
  if (node.form) {
    const { op, from } = node.form;
    return from ? (
      <Prefilled service={api} operation={op} source={from} fixed={params(node.form, { ids })} ids={ids} />
    ) : (
      <OperationForm key={op} service={api} operation={op} initial={params(node.form, { ids })} submitLabel="Submit" />
    );
  }
  if (node.sections) {
    return node.sections.map((section) => (
      <details key={section.id} open={!!section.show}>
        <summary>{section.label}</summary>
        <NodeView node={section} place={{ ...place, api }} rest={[]} creating={false} />
      </details>
    ));
  }
  if (node.link) return <Link to={fillLink(node.link, ids)}>Open {node.label.toLowerCase()}</Link>;
  const Custom = CUSTOM[node.custom!];
  return Custom ? <Custom ids={ids} /> : <p className="bad">Unknown view: {node.custom}</p>;
}

function Show({ service, operation, params }: { service: string; operation: string; params: Params }) {
  const { data, error, refetch, isFetching } = useAws(service, operation, params);
  return (
    <>
      <div className="row">
        <button onClick={() => refetch()} disabled={isFetching}>Refresh</button>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {isFetching && !data && <p>Loading…</p>}
      {data && !error && <Json value={data.result} />}
    </>
  );
}

/** The content, and the request for it, only after the reader asks. */
function Reveal({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <div className="row">
        <button className="primary" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? "Hide value" : "Show value"}
        </button>
      </div>
      {shown && children}
    </>
  );
}

function Prefilled({ service, operation, source, fixed, ids }: { service: string; operation: string; source: Source; fixed: Params; ids: string[] }) {
  const { data, error } = useAws(service, source.op, params(source, { ids }));
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const initial = { ...current(data.result, source), ...fixed };
  return <OperationForm service={service} operation={operation} initial={initial} submitLabel="Save" />;
}

function Create({ node, place }: { node: Node; place: Place }) {
  const create = node.create!;
  const Custom = create.custom ? CUSTOM[create.custom] : undefined;
  return (
    <>
      <div className="row">
        <h2>{create.label ?? "Create"}</h2>
        <Link to={href(place.service, place.tab, place.path)}>Back to the list</Link>
      </div>
      {Custom ? (
        <Custom ids={place.ids} />
      ) : (
        <OperationForm service={place.api} operation={create.op} initial={params(create, { ids: place.ids })} submitLabel="Submit" />
      )}
    </>
  );
}

type Action = Call & { label: string; danger?: boolean };

function ListView({ node, place }: { node: Node; place: Place }) {
  const listing = node.list!;
  const { region, account } = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const [token, setToken] = useState<Params>();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { choose } = listing;
  const [choice, setChoice] = useState(choose?.options[0] ?? "");
  const base = { ...params(listing, { ids: place.ids }), ...(choose && { [choose.name]: choice }) };
  const { data, error, refetch, isFetching } = useAws(place.api, listing.op, { ...base, ...token });

  const rows = ((data && getPath(data.result, listing.items)) ?? []) as Row[];
  const heads = columns(rows, listing);
  const shown = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(filter.toLowerCase()));
  const keyOf = (row: Row) => rowKey(row, listing.key);
  const chosen = rows.filter((row) => selected.has(keyOf(row)));

  const actions: Action[] = [
    ...(node.actions ?? []),
    ...(node.remove ? [{ ...node.remove, label: node.remove.label ?? "Remove", danger: true }] : []),
  ];
  const act = useMutation({
    mutationFn: async ({ action, targets }: { action: Action; targets: Row[] }) => {
      const failed: string[] = [];
      for (const row of targets) {
        const key = keyOf(row);
        try {
          const context = { ids: place.ids, row, key };
          const { first } = action;
          const found = first && (await call(place.api, first.op, params(first, context)));
          await call(place.api, action.op, { ...params(action, context), ...picked(found?.result, first?.also) });
        } catch (e) {
          failed.push(`${key}: ${(e as Error).message}`);
        }
      }
      if (failed.length) throw new Error(failed.join("\n"));
    },
    onSettled: () => {
      setSelected(new Set());
      return refresh();
    },
  });
  const confirmAct = (action: Action) => {
    const names = chosen.map(keyOf);
    // a scheduled deletion can still be cancelled
    const final = action.danger && !action.label.startsWith("Schedule") ? "\n\nThis cannot be undone." : "";
    const warning = `${action.label} ${names.length} selected in ${node.label.toLowerCase()} (${account}, ${region})?\n\n${names.map(nameOf).join("\n")}${final}`;
    if (window.confirm(warning)) act.mutate({ action, targets: chosen });
  };
  const toggle = (keys: string[], on: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      for (const key of keys) on ? next.add(key) : next.delete(key);
      return next;
    });
  const turn = (to: Params | undefined) => {
    setSelected(new Set());
    setToken(to);
  };

  return (
    <>
      <div className="row">
        {choose && (
          <label className="choice">
            {title(choose.name)}
            <select value={choice} onChange={(e) => { setChoice(e.target.value); turn(undefined); }}>
              {choose.options.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
        )}
        <input type="search" aria-label="Filter this page" placeholder="Filter this page" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => refetch()} disabled={isFetching}>Refresh</button>
        {node.create && (
          <Link className="button primary" to={href(place.service, place.tab, place.path, { new: "1" })}>
            {node.create.label ?? "Create"}
          </Link>
        )}
        {actions.map((action) => (
          <button key={action.label} className={action.danger ? "danger" : undefined} disabled={chosen.length === 0 || act.isPending} onClick={() => confirmAct(action)}>
            {action.label} selected ({chosen.length})
          </button>
        ))}
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {act.error && <p role="alert" className="bad lines">{act.error.message}</p>}
      {isFetching && !data && <p>Loading…</p>}
      {data && !error && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {actions.length > 0 && (
                  <th className="check">
                    <input type="checkbox" aria-label="Select all shown" checked={shown.length > 0 && shown.every((row) => selected.has(keyOf(row)))}
                      onChange={(e) => toggle(shown.map(keyOf), e.target.checked)} />
                  </th>
                )}
                {(heads.length ? heads : [listing.items.replace(/s$/, "")]).map((name) => (
                  <th key={name}>{title(name)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const key = keyOf(row);
                const values = typeof row === "string" ? [row] : heads.map((name) => cell(getPath(row, name), name));
                return (
                  <tr key={key}>
                    {actions.length > 0 && (
                      <td className="check">
                        <input type="checkbox" aria-label={`Select ${key}`} checked={selected.has(key)} onChange={(e) => toggle([key], e.target.checked)} />
                      </td>
                    )}
                    {values.map((value, i) => (
                      <td key={i}>
                        {i === 0 && node.views?.length ? (
                          <Link to={href(place.service, place.tab, [...place.path, key, node.views[0].id])}>{value}</Link>
                        ) : (
                          value
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && !error && rows.length === 0 && (
        <p className="muted">
          Nothing here in {region}, account {account}. If you expected something, check the region and account in the sidebar.
        </p>
      )}
      {(token || data?.next) && (
        <div className="row">
          <button disabled={!token} onClick={() => turn(undefined)}>First page</button>
          <button disabled={!data?.next} onClick={() => turn(data!.next!)}>Next page</button>
        </div>
      )}
    </>
  );
}
