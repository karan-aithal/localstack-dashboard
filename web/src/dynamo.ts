/** DynamoDB's typed JSON: readable display, item keys and query parameters. */

import type { Params } from "./params.ts";

export type Attribute = Record<string, unknown>;
export type Item = Record<string, Attribute>;
export type KeySchema = { AttributeName: string; KeyType: "HASH" | "RANGE" }[];
export type AttributeTypes = { AttributeName: string; AttributeType: string }[];

/** Short readable form of a value, for table cells only: editing keeps the typed JSON. */
export function plain(attribute: Attribute | undefined): unknown {
  if (!attribute) return undefined;
  const [type, value] = Object.entries(attribute)[0] ?? [];
  if (type === "NULL") return null;
  if (type === "N") return value; // kept as text: it may exceed JavaScript's precision
  if (type === "L") return (value as Attribute[]).map(plain);
  if (type === "M") return Object.fromEntries(Object.entries(value as Item).map(([k, v]) => [k, plain(v)]));
  return value;
}

export const itemKey = (item: Item, schema: KeySchema): Item =>
  Object.fromEntries(schema.map(({ AttributeName }) => [AttributeName, item[AttributeName]]));

const typeOf = (name: string, types: AttributeTypes) =>
  types.find((t) => t.AttributeName === name)?.AttributeType ?? "S";

/** A new item holding just the key attributes, for the editor. */
export const emptyItem = (schema: KeySchema, types: AttributeTypes): Item =>
  Object.fromEntries(schema.map(({ AttributeName }) => [AttributeName, { [typeOf(AttributeName, types)]: "" }]));

export const SORT_OPERATORS = ["=", "<", "<=", ">", ">=", "begins_with"];

export function queryParams(
  schema: KeySchema,
  types: AttributeTypes,
  partition: string,
  sort: { operator: string; value: string },
): Params {
  const name = (role: "HASH" | "RANGE") => schema.find((key) => key.KeyType === role)?.AttributeName;
  const hash = name("HASH")!;
  const range = name("RANGE");
  const names: Record<string, string> = { "#pk": hash };
  const values: Item = { ":pk": { [typeOf(hash, types)]: partition } };
  let condition = "#pk = :pk";
  if (range && sort.value !== "") {
    names["#sk"] = range;
    values[":sk"] = { [typeOf(range, types)]: sort.value };
    if (!SORT_OPERATORS.includes(sort.operator)) throw new Error(`Unknown operator: ${sort.operator}`);
    condition +=
      sort.operator === "begins_with" ? " AND begins_with(#sk, :sk)" : ` AND #sk ${sort.operator} :sk`;
  }
  return { KeyConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}
