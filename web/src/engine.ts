/** Pure helpers of the resource browser: how registry.json becomes parameters, rows and links. */

import type { Params } from "./params.ts";

export type Call = { op: string; params?: Params; label?: string; custom?: string };
/** `reveal` hides the result, such as a secret value, until it is asked for. */
export type Read = Call & { reveal?: boolean };
/** `choose` is a parameter the reader picks from a dropdown, the first option to begin with. */
export type Listing = Call & {
  items: string;
  key?: string | string[];
  columns?: string[];
  choose?: { name: string; options: string[] };
};

export type Source = Call & { path: string; as?: string; also?: Record<string, string> };

/** Form values from what the instance answered. */
export function current(result: unknown, { path, as, also = {} }: Source): Params {
  const value = getPath(result, path) ?? {};
  const extra = Object.entries(also).map(([field, from]) => [field, getPath(result, from)]);
  return { ...(as ? { [as]: value } : (value as Params)), ...Object.fromEntries(extra) };
}

/** One page of the browser. Exactly one of list, show, form, custom, link or sections is set. */
export type Node = {
  id: string;
  label: string;
  service?: string;
  list?: Listing;
  create?: Call;
  remove?: Call;
  /** further operations on the selected rows */
  actions?: (Call & { label: string })[];
  views?: Node[];
  show?: Read;
  /**
   * `from` reads the current values first; `as` names the field if the read value is a single one,
   * and `also` fills further fields from other paths of the same answer.
   */
  form?: Call & { from?: Source };
  custom?: string;
  link?: string;
  sections?: Node[];
};

export type Service = { id: string; title: string; group: string; service: string; tabs: Node[] };

/** An entry of an AWS list response: usually an object, sometimes just a name. */
export type Row = string | Record<string, unknown>;

type Context = { ids?: string[]; row?: Row; key?: string };

function lookup(placeholder: string, { ids = [], row, key }: Context): unknown {
  if (placeholder === "$key") return key;
  if (placeholder === "$row") return row;
  // an id that must differ on every request
  if (placeholder === "$now") return String(Date.now());
  if (placeholder.startsWith("$row.")) return typeof row === "object" ? row[placeholder.slice(5)] : undefined;
  const index = Number(placeholder.slice(1));
  // "#1" is the second id as a number
  return placeholder.startsWith("#") && ids[index] !== undefined ? Number(ids[index]) : ids[index];
}

/** Fill "$0", "#1", "$key", "$row", "$row.Field" and "$now" in a template. Unknown values are left out. */
export function substitute(template: unknown, context: Context): unknown {
  if (typeof template === "string") {
    return /^(\$key|\$now|\$row(\.\w+)?|[$#]\d)$/.test(template) ? lookup(template, context) : template;
  }
  if (Array.isArray(template)) return template.map((entry) => substitute(entry, context));
  if (typeof template === "object" && template !== null) {
    return Object.fromEntries(
      Object.entries(template)
        .map(([name, value]) => [name, substitute(value, context)])
        .filter(([, value]) => value !== undefined),
    );
  }
  return template;
}

export const params = (call: Call, context: Context) => substitute(call.params ?? {}, context) as Params;

/** Fill "$0" inside a link, escaped for use in a URL. */
export const fillLink = (link: string, ids: string[]) =>
  link.replace(/\$(\d)/g, (_, index) => encodeURIComponent(ids[Number(index)] ?? ""));

const child = (node: unknown, part: string) => (node as Record<string, unknown> | undefined)?.[part];

/**
 * Value at a dot separated path such as "MetricAlarms.0". A name applied to a list collects it from
 * every entry, so "Reservations.Instances" is one list. The empty path is the value itself.
 */
export const getPath = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (node, part) =>
        Array.isArray(node) && !/^\d+$/.test(part) ? node.flatMap((entry) => child(entry, part) ?? []) : child(node, part),
      value,
    );

export function rowKey(row: Row, key: Listing["key"]): string {
  if (typeof row === "string") return row;
  if (Array.isArray(key)) return JSON.stringify(Object.fromEntries(key.map((name) => [name, row[name]])));
  return String(row[key ?? ""]);
}

/** Short name of a resource id for headings: the end of a URL or ARN, or the parts of a combined key. */
export function label(id: string): string {
  if (/^https?:\/\//.test(id)) return id.split("/").pop() || id;
  if (id.startsWith("arn:") || id.startsWith("/hostedzone/")) return id.split(/[:/]/).pop() || id;
  if (id.startsWith("{")) {
    try {
      return Object.values(JSON.parse(id)).map((part) => cell(part)).filter((part) => part && part !== "[]").join(" / ");
    } catch {
      return id;
    }
  }
  return id;
}

/** Columns from the listing, otherwise the plain fields of the first rows. */
export function columns(rows: Row[], listing: Listing): string[] {
  if (listing.columns) return listing.columns;
  const found = new Set<string>();
  for (const row of rows.slice(0, 20)) {
    if (typeof row === "string") return [];
    for (const [name, value] of Object.entries(row)) if (typeof value !== "object") found.add(name);
  }
  return [...found].slice(0, 6);
}

/** "BucketRegion" and "logGroupName" as headings. */
export const title = (name: string) =>
  name.replace(/\./g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase());

export function cell(value: unknown, column = ""): string {
  if (value === undefined || value === null) return "";
  // epoch milliseconds, as CloudWatch Logs reports times
  if (typeof value === "number" && value > 1e12 && /time|date/i.test(column)) return new Date(value).toISOString();
  if (Array.isArray(value) && value.every((v) => v && typeof v === "object" && "Value" in v)) {
    return value.map((v) => ("Name" in v ? `${v.Name}=${v.Value}` : String(v.Value))).join(", ");
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Address of a browser page. `path` alternates resource ids and view ids. */
export function href(service: string, tab: string, path: string[] = [], extra: Record<string, string> = {}) {
  const query = new URLSearchParams([...path.map((part) => ["p", part]), ...Object.entries(extra)]).toString();
  return `/resources/${service}/${tab}${query && `?${query}`}`;
}
