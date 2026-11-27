import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { api, instancePath } from "../api";
import type { InstanceMap } from "../main";

export default function Instances() {
  const client = useQueryClient();
  const { data = {} } = useQuery({ queryKey: ["instances"], queryFn: () => api<InstanceMap>("/api/instances") });
  const refresh = () => client.invalidateQueries();
  const save = useMutation({
    mutationFn: ({ name, ...body }: Record<string, string>) => api(instancePath(name), "PUT", body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) => api(instancePath(name), "DELETE"),
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    save.mutate(Object.fromEntries(new FormData(form)) as Record<string, string>, { onSuccess: () => form.reset() });
  };
  const error = save.error ?? remove.error;

  return (
    <>
      <h1>Instances</h1>
      <div className="scroll">
        <table>
          <thead><tr><th>Name</th><th>Endpoint</th><th>Container</th><th>API docs</th><th>Actions</th></tr></thead>
          <tbody>
            {Object.entries(data).map(([name, instance]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{instance.endpoint}</td>
                <td>{instance.container}</td>
                <td>
                  <a href={`${instance.endpoint}/_localstack/swagger`} target="_blank" rel="noreferrer">Open<span className="sr-only"> API docs of {name}</span></a>
                </td>
                <td>
                  <button
                    disabled={Object.keys(data).length === 1}
                    onClick={() => window.confirm(`Remove bookmark "${name}"?`) && remove.mutate(name)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">The API docs page is served by the instance and loads its viewer from unpkg.com.</p>
      <h2>Add or update a bookmark</h2>
      <form className="row" onSubmit={submit}>
        <input name="name" aria-label="Name" placeholder="Name" required pattern="[A-Za-z0-9_\-]{1,40}" />
        <input name="endpoint" aria-label="Endpoint" placeholder="http://localhost:4566" type="url" required />
        <input name="container" aria-label="Container name" placeholder="Container name" required />
        <button disabled={save.isPending}>Save</button>
      </form>
      {error && <p role="alert" className="bad">{error.message}</p>}
    </>
  );
}
