import { useMutation } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { api, instancePath, useInstance } from "../../api";
import { useAws, useAwsCall, useRefresh } from "../../aws";

/** Send one event to a bus. */
export function PutEvent({ ids }: { ids: string[] }) {
  const bus = ids[0];
  const call = useAwsCall();
  const refresh = useRefresh();
  const send = useMutation({
    mutationFn: async (values: Record<string, string>) => {
      JSON.parse(values.detail); // report bad JSON here rather than as a rejected entry
      const resources = values.resources.split("\n").map((line) => line.trim()).filter(Boolean);
      const { result } = await call<{ FailedEntryCount: number; Entries: { EventId?: string; ErrorMessage?: string }[] }>("events", "PutEvents", {
        Entries: [
          {
            EventBusName: bus,
            Source: values.source,
            DetailType: values.type,
            Detail: values.detail,
            ...(resources.length && { Resources: resources }),
          },
        ],
      });
      if (result.FailedEntryCount) throw new Error(result.Entries[0].ErrorMessage ?? "The event was rejected");
      return result.Entries[0].EventId;
    },
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send.mutate(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
  };

  return (
    <form onSubmit={submit}>
      <label className="field">Source *<input name="source" required defaultValue="my.application" /></label>
      <label className="field">Detail type *<input name="type" required defaultValue="my.event" /></label>
      <label className="field">Detail (JSON) *<textarea name="detail" className="code" rows={6} required defaultValue="{}" spellCheck={false} /></label>
      <label className="field">Resource ARNs, one per line<textarea name="resources" rows={2} spellCheck={false} /></label>
      <button className="primary" disabled={send.isPending}>Send event</button>
      {send.error && <p role="alert" className="bad">{send.error.message}</p>}
      {send.data && <p role="status" className="good">Sent. Event ID {send.data}</p>}
    </form>
  );
}

/** Run a rule's targets now. */
export function TriggerRule({ ids }: { ids: string[] }) {
  const [bus, rule] = ids;
  const instance = useInstance();
  const refresh = useRefresh();
  const { data, error } = useAws<{ Arn: string }>("events", "DescribeRule", { Name: rule, EventBusName: bus });
  const trigger = useMutation({
    mutationFn: (arn: string) => api(instancePath(instance, `/events/trigger?${new URLSearchParams({ arn })}`), "POST"),
    onSuccess: refresh,
  });
  if (error) return <p role="alert" className="bad">{error.message}</p>;

  return (
    <>
      <p>Runs the targets of this rule now, without waiting for its schedule or a matching event.</p>
      <button className="primary" disabled={!data || trigger.isPending} onClick={() => trigger.mutate(data!.result.Arn)}>
        Trigger rule
      </button>
      {trigger.error && <p role="alert" className="bad">{trigger.error.message}</p>}
      {trigger.isSuccess && <p role="status" className="good">Triggered.</p>}
    </>
  );
}
