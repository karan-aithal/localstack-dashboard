/** Conversion between the generated form (one text value per field) and request parameters. */

export type Field = {
  name: string;
  type: string;
  required: boolean;
  enum: string[];
  documentation: string;
  template: unknown;
  /** names a nested structure takes */
  members?: string[];
};

export type Params = Record<string, unknown>;
export type Values = Record<string, string>;

export const NUMBERS = new Set(["integer", "long", "float", "double"]);
const TEXT = new Set(["string", "timestamp", "blob"]);

export const isDestructive = (operation: string) => /Delete|Deletion|Terminate|Purge|Remove/.test(operation);

const S3_NAME = /s3\w*(uri|url|path|location)|(output|script)location|modeldataurl/i;

/** Whether a field, or anything nested in it, takes an S3 address, going by the names. */
export const takesS3 = ({ name, template }: Field) =>
  S3_NAME.test(name) || [...(JSON.stringify(template)?.matchAll(/"(\w+)":/g) ?? [])].some(([, key]) => S3_NAME.test(key));

export function parseParams(json: string): Params {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Parameters must be a JSON object");
  }
  return value as Params;
}

/** Empty fields are left out; use the JSON editor to send an empty string. */
export function toParams(values: Values, fields: Field[]): Params {
  const params: Params = {};
  for (const { name, type } of fields) {
    const raw = values[name];
    if (raw === undefined || raw === "") continue;
    if (TEXT.has(type)) {
      params[name] = raw;
    } else if (NUMBERS.has(type)) {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`${name}: not a number`);
      params[name] = number;
    } else if (type === "boolean") {
      params[name] = raw === "true";
    } else {
      try {
        params[name] = JSON.parse(raw);
      } catch {
        throw new Error(`${name}: invalid JSON`);
      }
    }
  }
  return params;
}

/** What was read often holds more than the change takes, such as a creation time: leave that out. */
export function accepted(value: unknown, { members }: Field): unknown {
  if (!members?.length || typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => members.includes(name)));
}

/** Throws rather than silently dropping or retyping anything the form cannot hold. */
export function toValues(params: Params, fields: Field[]): Values {
  const types = new Map(fields.map((field) => [field.name, field.type]));
  const values: Values = {};
  for (const [name, value] of Object.entries(params)) {
    const type = types.get(name);
    if (type === undefined) throw new Error(`Unknown parameter: ${name}`);
    if (!TEXT.has(type)) values[name] = JSON.stringify(value, null, 2);
    else if (typeof value === "string") values[name] = value;
    else throw new Error(`${name}: expected a string`);
  }
  return values;
}

export const encodeText = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));

/** Null if the base64 string does not hold UTF-8 text. */
export function decodeText(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
