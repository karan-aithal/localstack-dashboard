/** Turning traced operations (spans) into requests, a flow graph and a sequence. */

export type Span = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  start_time_unix_nano: string | null;
  end_time_unix_nano: string | null;
  service_name: string;
  operation_name: string;
  operation_status: string;
  resource_name: string;
  arn: string;
  account_id: string;
  region: string;
  kind: number;
  status_message: string | null;
  iam_errors_suppressed?: boolean | null;
  attributes: Record<string, unknown> | null;
};

/** A request and everything it caused. */
export type Trace = { id: string; root: Span; spans: Span[]; errors: number; warnings: number; consumer: string };

export const CLIENT = "Client";

export const isError = (span: Span) => /error|deny/.test(span.operation_status);
export const isWarning = (span: Span) => span.operation_status.endsWith("warn");

/** Timestamps arrive as nanoseconds in text, too long for a number. */
export const millis = (nano: string | null) => (nano ? Number(BigInt(nano) / 1000n) / 1000 : 0);

export const participant = (span: Span) =>
  span.resource_name ? `${span.service_name}: ${span.resource_name}` : span.service_name;

/** Who made the call: the operation that led to it, or the client outside. */
export function caller(span: Span, spans: Span[]) {
  const parent = spans.find((s) => s.span_id === span.parent_span_id);
  return parent ? participant(parent) : CLIENT;
}

/** Newest request first, the operations of each in the order they started. */
export function traces(spans: Span[]): Trace[] {
  const grouped = new Map<string, Span[]>();
  for (const span of spans) grouped.set(span.trace_id, [...(grouped.get(span.trace_id) ?? []), span]);
  return [...grouped]
    .map(([id, group]) => {
      const ordered = [...group].sort((a, b) => millis(a.start_time_unix_nano) - millis(b.start_time_unix_nano));
      // the plan may have dropped the parent: then the earliest operation stands for the request
      const root = ordered.find((s) => !s.parent_span_id) ?? ordered[0];
      return {
        id,
        root,
        spans: ordered,
        errors: ordered.filter(isError).length,
        warnings: ordered.filter(isWarning).length,
        consumer: caller(root, ordered),
      };
    })
    .sort((a, b) => millis(b.root.start_time_unix_nano) - millis(a.root.start_time_unix_nano));
}

export type Link = { from: string; to: string; operations: string[]; failed: boolean };

/** Nodes in columns by their distance from the client, and the calls between them. */
export function flow(spans: Span[]): { columns: string[][]; links: Link[] } {
  const links = new Map<string, Link>();
  for (const span of spans) {
    const from = caller(span, spans);
    const to = participant(span);
    const key = JSON.stringify([from, to]);
    const link = links.get(key) ?? { from, to, operations: [], failed: false };
    if (!link.operations.includes(span.operation_name)) link.operations.push(span.operation_name);
    link.failed ||= isError(span);
    links.set(key, link);
  }
  const all = [...links.values()];
  const depth = new Map<string, number>([[CLIENT, 0]]);
  // as many passes as there are links reach every node, also when calls form a loop
  for (let pass = 0; pass < all.length; pass++) {
    for (const { from, to } of all) {
      const next = depth.get(from);
      if (next !== undefined && !depth.has(to)) depth.set(to, next + 1);
    }
  }
  const columns: string[][] = [];
  for (const name of new Set(all.flatMap(({ from, to }) => [from, to]))) {
    (columns[depth.get(name) ?? 1] ??= []).push(name);
  }
  return { columns: columns.filter(Boolean), links: all };
}

/** Recorded request and response bodies are JSON text. */
export function payload(span: Span, side: "request" | "response"): string | null {
  const value = span.attributes?.[`localstack.aws.service.${side}`];
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
