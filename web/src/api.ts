import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

/** Name of the selected instance bookmark. */
export const InstanceContext = createContext("default");

export const useInstance = () => useContext(InstanceContext);

export type Scope = { region: string; account: string };

/** Region and account that AWS calls are made in. */
export const ScopeContext = createContext<Scope>({ region: "us-east-1", account: "000000000000" });

export const useScope = () => useContext(ScopeContext);

export const instancePath = (name: string, suffix = "") =>
  `/api/instances/${encodeURIComponent(name)}${suffix}`;

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      "x-dashboard": "1",
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null))?.detail;
    throw new Error(typeof detail === "string" ? detail : `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

/** Poll a read endpoint of the selected instance. */
export function useInstanceQuery<T>(suffix: string, refetchInterval: number | false = 5000) {
  const name = useInstance();
  return useQuery({
    queryKey: [name, suffix],
    queryFn: () => api<T>(instancePath(name, suffix)),
    refetchInterval,
  });
}
