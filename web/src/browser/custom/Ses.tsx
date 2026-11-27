import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, instancePath, useInstance, useInstanceQuery } from "../../api";
import { useAws, useAwsCall, useRefresh } from "../../aws";

const addresses = (text: string) => text.split(/[,\s]+/).filter(Boolean);

export function SendEmail() {
  const call = useAwsCall();
  const refresh = useRefresh();
  const identities = useAws<{ Identities: string[] }>("ses", "ListIdentities");
  const send = useMutation({
    mutationFn: async (values: Record<string, string>) => {
      if (!values.text && !values.html) throw new Error("Write a text or an HTML body");
      const { result } = await call<{ MessageId: string }>("ses", "SendEmail", {
        Source: values.from,
        Destination: { ToAddresses: addresses(values.to), CcAddresses: addresses(values.cc), BccAddresses: addresses(values.bcc) },
        Message: {
          Subject: { Data: values.subject },
          Body: { ...(values.text && { Text: { Data: values.text } }), ...(values.html && { Html: { Data: values.html } }) },
        },
      });
      return result.MessageId;
    },
    onSuccess: refresh,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send.mutate(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
  };

  return (
    <form onSubmit={submit}>
      <p className="muted">The sender must be a verified identity. LocalStack keeps the message under Sent mail.</p>
      <label className="field">From *<input name="from" type="email" required list="identities" size={40} /></label>
      <datalist id="identities">
        {identities.data?.result.Identities.map((identity) => <option key={identity} value={identity} />)}
      </datalist>
      <label className="field">To (separate with commas) *<input name="to" required size={60} /></label>
      <label className="field">Cc<input name="cc" size={60} /></label>
      <label className="field">Bcc<input name="bcc" size={60} /></label>
      <label className="field">Subject *<input name="subject" required size={60} /></label>
      <label className="field">Text body<textarea name="text" rows={5} /></label>
      <label className="field">HTML body<textarea name="html" className="code" rows={5} spellCheck={false} /></label>
      <button className="primary" disabled={send.isPending}>Send</button>
      {send.error && <p role="alert" className="bad">{send.error.message}</p>}
      {send.data && <p role="status" className="good">Sent. Message ID {send.data}</p>}
    </form>
  );
}

type Mail = {
  Id: string;
  Timestamp?: string;
  Region?: string;
  Source?: string;
  Subject?: string;
  Destination?: Record<string, string[]>;
  Body?: { text_part?: string | null; html_part?: string | null };
  RawData?: string;
};

// mail is untrusted: no scripts, no requests to anywhere, no access to this page
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

const recipients = (mail: Mail) =>
  Object.entries(mail.Destination ?? {})
    .filter(([, list]) => list?.length)
    .map(([kind, list]) => `${kind.replace("Addresses", "")}: ${list.join(", ")}`)
    .join("; ");

export function Mailbox() {
  const instance = useInstance();
  const [open, setOpen] = useState<string>();
  const list = useInstanceQuery<Mail[]>("/ses/messages", false);
  const remove = useMutation({
    mutationFn: (id?: string) => api(instancePath(instance, `/ses/messages${id ? `?${new URLSearchParams({ id })}` : ""}`), "DELETE"),
    onSettled: () => list.refetch(),
  });
  const mails = [...(list.data ?? [])].sort((a, b) => (b.Timestamp ?? "").localeCompare(a.Timestamp ?? ""));
  const mail = mails.find((m) => m.Id === open);
  const error = list.error ?? remove.error;

  return (
    <>
      <div className="row">
        <button onClick={() => list.refetch()} disabled={list.isFetching}>Refresh</button>
        <button className="danger" disabled={mails.length === 0 || remove.isPending}
          onClick={() => window.confirm(`Delete all ${mails.length} stored messages of instance "${instance}", in every region? This cannot be undone.`) && remove.mutate(undefined)}>
          Delete all
        </button>
      </div>
      {error && <p role="alert" className="bad">{error.message}</p>}
      {list.data && mails.length === 0 && <p className="muted">No mail has been sent.</p>}
      {mails.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Subject</th><th>From</th><th>Recipients</th><th>Region</th><th>Time</th><th>Actions</th></tr></thead>
            <tbody>
              {mails.map((m) => (
                <tr key={m.Id}>
                  <td>{m.Subject ?? "(raw message)"}</td>
                  <td>{m.Source}</td>
                  <td>{recipients(m)}</td>
                  <td>{m.Region}</td>
                  <td>{m.Timestamp}</td>
                  <td className="actions">
                    <button onClick={() => setOpen(m.Id)}>Open</button>
                    <button onClick={() => window.confirm("Delete this message? This cannot be undone.") && remove.mutate(m.Id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mail && (
        <section aria-label="Message">
          <div className="row">
            <h2>{mail.Subject ?? "Raw message"}</h2>
            <button onClick={() => setOpen(undefined)}>Close message</button>
          </div>
          {mail.Body?.html_part && <iframe className="mail" title="HTML body" sandbox="" srcDoc={POLICY + mail.Body.html_part} />}
          {(mail.Body?.text_part || mail.RawData) && <pre className="response" tabIndex={0}>{mail.Body?.text_part || mail.RawData}</pre>}
        </section>
      )}
    </>
  );
}
