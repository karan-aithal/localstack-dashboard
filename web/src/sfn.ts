/** Reading a Step Functions definition (Amazon States Language) as a graph. */

export type State = {
  Type: string;
  Next?: string;
  Default?: string;
  End?: boolean;
  Choices?: { Next: string }[];
  Catch?: { Next: string }[];
  Branches?: Machine[];
  ItemProcessor?: Machine;
  Iterator?: Machine;
};
export type Machine = { StartAt: string; States: Record<string, State> };
export type Edge = { from: string; to: string; kind: "next" | "choice" | "catch" };

export function edges({ States }: Machine): Edge[] {
  return Object.entries(States).flatMap(([from, state]) => {
    const found: Edge[] = [
      ...(state.Next ? [{ from, to: state.Next, kind: "next" as const }] : []),
      ...(state.Choices ?? []).map(({ Next }) => ({ from, to: Next, kind: "choice" as const })),
      ...(state.Default ? [{ from, to: state.Default, kind: "choice" as const }] : []),
      ...(state.Catch ?? []).map(({ Next }) => ({ from, to: Next, kind: "catch" as const })),
    ];
    // several choice rules may lead to the same state: draw one line
    return found.filter((edge, i) => edge.to in States && found.findIndex((e) => e.to === edge.to) === i);
  });
}

/** Rows of states, by distance from the start. States nothing leads to come last. */
export function layers(machine: Machine): string[][] {
  const all = edges(machine);
  const seen = new Set<string>();
  const rows: string[][] = [];
  let row = machine.StartAt in machine.States ? [machine.StartAt] : [];
  while (row.length) {
    rows.push(row);
    row.forEach((name) => seen.add(name));
    row = [...new Set(row.flatMap((name) => all.filter((e) => e.from === name && !seen.has(e.to)).map((e) => e.to)))];
  }
  const unreached = Object.keys(machine.States).filter((name) => !seen.has(name));
  return unreached.length ? [...rows, unreached] : rows;
}

/** Machines inside a Parallel or Map state. */
export function nested({ States }: Machine): { title: string; machine: Machine }[] {
  return Object.entries(States).flatMap(([name, state]) => {
    const each = state.ItemProcessor ?? state.Iterator;
    return [
      ...(state.Branches ?? []).map((machine, i) => ({ title: `${name}: branch ${i + 1}`, machine })),
      ...(each ? [{ title: `${name}: each item`, machine: each }] : []),
    ];
  });
}
