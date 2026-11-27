import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { api, InstanceContext, ScopeContext, useInstanceQuery } from "./api";
import Browser from "./browser/Browser";
import AppInspector from "./pages/AppInspector";
import Config from "./pages/Config";
import Explorer from "./pages/Explorer";
import Extensions from "./pages/Extensions";
import Insights from "./pages/Insights";
import Instances from "./pages/Instances";
import Logs from "./pages/Logs";
import Overview from "./pages/Overview";
import Stack from "./pages/Stack";
import Status from "./pages/Status";
import "./styles.css";

export type InstanceMap = Record<string, { endpoint: string; container: string }>;

const PAGES = [
  { path: "/", label: "Overview", page: <Overview /> },
  { path: "/status", label: "Status", page: <Status /> },
  { path: "/stack", label: "Stack", page: <Stack /> },
  { path: "/resources", route: "/resources/:service?/:tab?", label: "Resources", page: <Browser /> },
  { path: "/explorer", route: "/explorer/:service?/:operation?", label: "Explorer", page: <Explorer /> },
  { path: "/app-inspector", label: "App Inspector", page: <AppInspector />, plugin: "appinspector" },
  { path: "/extensions", label: "Extensions", page: <Extensions />, plugin: "extensions" },
  { path: "/insights", route: "/insights/:session?", label: "Stack Insights", page: <Insights /> },
  { path: "/logs", label: "Logs", page: <Logs /> },
  { path: "/config", label: "Config", page: <Config /> },
  { path: "/instances", label: "Instances", page: <Instances /> },
];

const REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
];

/** Show a page only if the instance loaded its plugin; otherwise make none of its calls. */
function RequiresPlugin({ name, children }: { name: string; children: ReactNode }) {
  const { data, error } = useInstanceQuery<{ plugins: { name: string; is_loaded: boolean }[] }>("/overview", false);
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  return data.plugins.some((p) => p.name === name && p.is_loaded) ? children : <p className="warn">Not in your plan.</p>;
}

function read(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice just is not remembered */
  }
}

function App() {
  const [selected, setSelected] = useState(() => read("instance", "default"));
  const [scope, setScope] = useState(() => ({
    region: read("region", "us-east-1"),
    account: read("account", "000000000000"),
  }));
  const instances = useQuery({ queryKey: ["instances"], queryFn: () => api<InstanceMap>("/api/instances") });

  if (instances.error) return <main role="alert">Backend unreachable: {instances.error.message}</main>;
  if (!instances.data) return <main>Loading…</main>;

  const names = Object.keys(instances.data);
  const current = names.includes(selected) ? selected : names[0];
  const select = (name: string) => {
    setSelected(name);
    write("instance", name);
  };
  const selectScope = (key: "region" | "account", value: string) => {
    setScope((old) => ({ ...old, [key]: value }));
    write(key, value);
  };

  return (
    <InstanceContext.Provider value={current}>
      <ScopeContext.Provider value={scope}>
        <nav aria-label="Main">
          <strong>Local Cloud</strong>
          <label>
            Instance
            <select value={current} onChange={(e) => select(e.target.value)}>
              {names.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {PAGES.map(({ path, label }) => (
            <NavLink key={path} to={path} end={path === "/"}>
              {label}
            </NavLink>
          ))}
          <label>
            Region
            <select value={scope.region} onChange={(e) => selectScope("region", e.target.value)}>
              {REGIONS.map((region) => (
                <option key={region}>{region}</option>
              ))}
            </select>
          </label>
          <label>
            Account ID
            {/* applied only once it is a complete, valid ID */}
            <input
              defaultValue={scope.account}
              inputMode="numeric"
              pattern="\d{12}"
              required
              maxLength={12}
              onChange={(e) => e.target.validity.valid && selectScope("account", e.target.value)}
            />
          </label>
        </nav>
        {/* keyed so that page state (log buffer, form input) never carries over between instances */}
        <main key={current}>
          <Routes>
            {PAGES.map(({ path, route, page, plugin }) => (
              <Route key={path} path={route ?? path} element={plugin ? <RequiresPlugin name={plugin}>{page}</RequiresPlugin> : page} />
            ))}
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </main>
      </ScopeContext.Provider>
    </InstanceContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
