import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery } from "../api";
import { Json } from "../components/OperationForm";
import catalog from "../extensions.json";

type Installed = { name: string | null; version: string | null; details: unknown };
type Outcome = { ok: boolean; events: { event: string; message: string }[] };

export default function Extensions() {
  const instance = useInstance();
  const installed = useInstanceQuery<Installed[]>("/extensions", false);
  const [filter, setFilter] = useState("");
  const install = useMutation({
    mutationFn: (name: string) => api<Outcome>(instancePath(instance, "/extensions/install"), "POST", { package: name }),
    onSettled: () => installed.refetch(),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api(instancePath(instance, "/extensions/uninstall"), "POST", { package: name }),
    onSettled: () => installed.refetch(),
  });
  const busy = install.isPending || remove.isPending;

  const confirmInstall = (name: string) => {
    const warning = `Install "${name}" on instance "${instance}"?\n\nThis downloads the package from the Python package index and runs its code inside your instance, with access to everything the instance holds. Install only packages you trust.`;
    if (window.confirm(warning)) install.mutate(name);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    confirmInstall(String(new FormData(event.currentTarget).get("package")).trim());
  };
  const have = new Set(installed.data?.map((extension) => extension.name));
  const shown = catalog.filter((e) => `${e.name} ${e.package} ${e.about}`.toLowerCase().includes(filter.toLowerCase()));
  const error = installed.error ?? install.error ?? remove.error;

  return (
    <>
      <h1>Extensions</h1>
      {error && <p role="alert" className="bad">{error.message}</p>}
      <h2>Installed</h2>
      {installed.data?.length === 0 && <p className="muted">No extensions installed.</p>}
      {!!installed.data?.length && (
        <table>
          <thead><tr><th>Package</th><th>Version</th><th></th></tr></thead>
          <tbody>
            {installed.data.map((extension, i) => (
              <tr key={extension.name ?? i}>
                <td>{extension.name ?? "Unnamed"}<details><summary>Details</summary><Json value={extension.details} /></details></td>
                <td>{extension.version}</td>
                <td>
                  <button className="danger" disabled={busy || !extension.name}
                    onClick={() => window.confirm(`Remove "${extension.name}" from instance "${instance}"?`) && remove.mutate(extension.name!)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">An installed or removed extension takes effect after the instance restarts. Without persistence, a restart empties the instance.</p>

      {install.isPending && <p role="status">Installing {install.variables}. This can take a few minutes.</p>}
      {install.data && (
        <section aria-label="Installation log">
          <p role="status" className={install.data.ok ? "good" : "bad"}>
            {install.data.ok ? `Installed ${install.variables}. Restart the instance to load it.` : `Installing ${install.variables} failed.`}
          </p>
          <details open={!install.data.ok}>
            <summary>Installer output</summary>
            <pre className="response" tabIndex={0}>{install.data.events.map((e) => e.message).join("\n")}</pre>
          </details>
        </section>
      )}

      <h2>Install by package name</h2>
      <form className="row" onSubmit={submit}>
        <input name="package" aria-label="Package name" placeholder="localstack-extension-name" required size={40}
          pattern="[A-Za-z0-9]([A-Za-z0-9._\-]{0,100}[A-Za-z0-9])?(==[A-Za-z0-9.]{1,30})?" />
        <button className="primary" disabled={busy}>Install</button>
      </form>
      <p className="muted">For a Git repository or a local folder, use the LocalStack command line.</p>

      <h2>Known extensions</h2>
      <div className="row">
        <input type="search" aria-label="Filter extensions" placeholder="Filter extensions" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul className="cards">
        {shown.map((extension) => (
          <li key={extension.package}>
            <strong>{extension.name}</strong>
            <span className="muted">{extension.publisher}</span>
            <span>{extension.about}</span>
            <code>{extension.package}</code>
            <div className="row">
              <button disabled={busy || have.has(extension.package)} onClick={() => confirmInstall(extension.package)}>
                {have.has(extension.package) ? "Installed" : "Install"}
              </button>
              <a href={`https://pypi.org/project/${extension.package}/`} target="_blank" rel="noreferrer">Read more</a>
            </div>
          </li>
        ))}
      </ul>

      <details>
        <summary>Build your own</summary>
        <p>
          An extension is a Python package that registers a <code>localstack.extensions</code> entry point. Publish it to
          the package index, then install it here by name, or run <code>localstack extensions install &lt;package&gt;</code>.
        </p>
      </details>
    </>
  );
}
