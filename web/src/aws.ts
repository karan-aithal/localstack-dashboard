/** AWS calls from the UI, made in the selected instance, region and account. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, instancePath, type Scope, useInstance, useScope } from "./api";
import type { Params } from "./params";

export type Result<T = Record<string, unknown>> = { status: number; result: T; next: Params | null };

export function useAwsCall() {
  const instance = useInstance();
  const current = useScope();
  /** `scope` pins a follow up call to where the first one was made */
  return <T = Record<string, unknown>>(service: string, operation: string, params: Params = {}, scope: Scope = current) =>
    api<Result<T>>(instancePath(instance, `/aws/${service}/${operation}`), "POST", { params, ...scope });
}

/** A read operation as a query: cached per instance and scope, refetched after any change. */
export function useAws<T = Record<string, unknown>>(service: string, operation: string, params: Params = {}, enabled = true) {
  const instance = useInstance();
  const { region, account } = useScope();
  const call = useAwsCall();
  return useQuery({
    queryKey: ["aws", instance, region, account, service, operation, params],
    queryFn: () => call<T>(service, operation, params),
    enabled,
  });
}

/** Call after changing something, so that lists and details are read again. */
export function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["aws"] });
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
