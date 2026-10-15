import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OrchestrationThreadStreamItem } from "@t3tools/contracts";
import { initialTurnState, step, type Awaiting, type TurnOutcome } from "../src/turn.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "turns");

type Case = { awaiting: Awaiting; items: OrchestrationThreadStreamItem[] };
type Expected = { outcome: TurnOutcome | null; settledAt: number | null };

function runCase({ awaiting, items }: Case): Expected {
  let state = initialTurnState(awaiting);
  for (const [index, item] of items.entries()) {
    state = step(state, item);
    if (state.outcome) return { outcome: state.outcome, settledAt: index };
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
