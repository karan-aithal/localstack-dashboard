/** Messages that LocalStack holds: SQS queues, and SNS deliveries that stay local. */

import { useScope, useInstanceQuery } from "../../api";
import { cell } from "../../engine";

type QueueMessage = { id: string; body: string; attributes: Record<string, string>; messageAttributes: Record<string, unknown> };

export function SqsMessages({ ids }: { ids: string[] }) {
  const { data, error, refetch, isFetching } = useInstanceQuery<QueueMessage[]>(
    `/sqs/messages?${new URLSearchParams({ queue_url: ids[0] })}`,
    false,
  );
  return (
    <>
      <div className="row">
        <button onClick={() => refetch()} disabled={isFetching}>Refresh</button>
        <span className="muted">Reading here does not receive or remove messages.</span>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data?.length === 0 && <p className="muted">The queue is empty.</p>}
      {!!data?.length && (
        <div className="scroll">
          <table>
            <thead><tr><th>Message ID</th><th>Body</th><th>Message attributes</th><th>Attributes</th></tr></thead>
            <tbody>
              {data.map((message) => (
                <tr key={message.id}>
                  <td>{message.id}</td>
                  <td className="lines">{message.body}</td>
                  <td>{cell(message.messageAttributes)}</td>
                  <td>{Object.entries(message.attributes).map(([k, v]) => `${k}=${v}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Sent = { sms: Record<string, Record<string, unknown>[]>; platform: Record<string, Record<string, unknown>[]> };

export function SnsSent() {
  const scope = useScope();
  const { data, error, refetch, isFetching } = useInstanceQuery<Sent>(`/sns/messages?${new URLSearchParams(scope)}`, false);
  return (
    <>
      <div className="row">
        <button onClick={() => refetch()} disabled={isFetching}>Refresh</button>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {data && <Delivered title="SMS" target="Phone number" byTarget={data.sms} />}
      {data && <Delivered title="Mobile push" target="Endpoint" byTarget={data.platform} />}
    </>
  );
}

function Delivered({ title, target, byTarget }: { title: string; target: string; byTarget: Sent["sms"] }) {
  const rows = Object.entries(byTarget).flatMap(([to, messages]) => messages.map((message) => ({ to, message })));
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">No messages.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead><tr><th>{target}</th><th>Message</th><th>Topic</th><th>Message ID</th></tr></thead>
            <tbody>
              {rows.map(({ to, message }, i) => (
                <tr key={i}>
                  <td>{to}</td>
                  <td className="lines">{cell(message.Message)}</td>
                  <td>{cell(message.TopicArn)}</td>
                  <td>{cell(message.MessageId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function SnsToken({ ids }: { ids: string[] }) {
  const arn = ids[1];
  const { data, error } = useInstanceQuery<{ token: string | null }>(
    `/sns/subscription-token?${new URLSearchParams({ arn })}`,
    false,
  );
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  return data.token ? (
    <>
      <p>Pass this token to the ConfirmSubscription operation to confirm the subscription.</p>
      <pre className="response" tabIndex={0}>{data.token}</pre>
    </>
  ) : (
    <p className="muted">No confirmation token: this subscription does not need one.</p>
  );
}
