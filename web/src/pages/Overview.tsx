import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";

type Plugin = { name: string; is_loaded: boolean; requires_license?: boolean };
type Data = {
  info: Record<string, string | number | boolean>;
  stackinfo: { top_user_agent?: string; is_ci?: boolean } | null;
  license_type: string | null;
  plugins: Plugin[];
};

const CONFIRM = {
  restart: "Restart the instance? State that is not persisted will be lost.",
  stop: "Stop the container? State that is not persisted will be lost.",
};

function Controls() {
  const name = useInstance();
  const client = useQueryClient();
  const container = useInstanceQuery<{ state: string }>("/container");
  const action = useMutation({
    mutationFn: (verb: string) => api(instancePath(name, `/actions/${verb}`), "POST"),
    onSettled: () => client.invalidateQueries({ queryKey: [name] }),
  });
  const state = container.data?.state;
  const running = state === "running";
  const run = (verb: "restart" | "stop") => window.confirm(CONFIRM[verb]) && action.mutate(verb);
  const error = action.error ?? container.error;

  return (
    <div className="row">
      <span>
        Container: <strong className={running ? "good" : "bad"}>{state ?? "…"}</strong>
      </span>
      <button disabled={action.isPending || running || !state || state === "missing"} onClick={() => action.mutate("start")}>
        Start
      </button>
      <button disabled={action.isPending || !running} onClick={() => run("restart")}>
        Restart
      </button>
      <button disabled={action.isPending || !running} onClick={() => run("stop")}>
        Stop
      </button>
      {error && (
        <span role="alert" className="bad">
          {error.message}
        </span>
      )}
    </div>
  );
}

export default function Overview() {
  const { data, error } = useInstanceQuery<Data>("/overview");

  return (
    <>
      <h1>Overview</h1>
      <Controls />
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data && !error && (
        <>
          <table>
            <tbody>
              {Object.entries({
                ...data.info,
                license_type: data.license_type ?? "none",
                ...(data.stackinfo && { is_ci: data.stackinfo.is_ci, top_user_agent: data.stackinfo.top_user_agent }),
              }).map(([key, value]) => (
                <tr key={key}>
                  <th scope="row">{key.replaceAll("_", " ")}</th>
                  <td>{String(value ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Features</h2>
          <ul className="grid">
            {data.plugins.map((plugin) => (
              <li key={plugin.name}>
                {plugin.name}
                <span className={plugin.is_loaded ? "good" : "muted"}>
                  {plugin.is_loaded ? "active" : plugin.requires_license ? "not in plan" : "inactive"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
