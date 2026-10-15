import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initialTurnState, outcome, step, type StreamItem, type Target, type TurnOutcome } from "../src/turn.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "turns");

type Case = { target: Target; items: StreamItem[] };
type Expected = { outcome: TurnOutcome | null; settledAt: number | null };

function runCase({ target, items }: Case): Expected {
  let state = initialTurnState(target);
  for (const [index, item] of items.entries()) {
    state = step(state, item);
    const settled = outcome(state);
    if (settled) return { outcome: settled, settledAt: index };
  }
  return { outcome: null, settledAt: null };
}

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".input.json")).sort()) {
  const stem = file.replace(/\.input\.json$/, "");
  test(`turn: ${stem}`, () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Case;
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${stem}.expected.json`), "utf8")) as Expected;
    assert.deepEqual(runCase(input), expected);
  });
}
