import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OrchestrationEvent, ThreadDetail } from "../src/contracts.ts";
import { applyEvent, settledOutcome, trackerFromDetail, type TurnOutcome } from "../src/turn.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "turns");

type Case = { detail: ThreadDetail; expectNewTurn: boolean; events: OrchestrationEvent[] };
type Expected = { outcome: TurnOutcome | null; settledAtEvent: number | null };

function runCase(input: Case): Expected {
  const tracker = trackerFromDetail(input.detail, input.expectNewTurn);
  const initial = settledOutcome(tracker, input.detail.latestTurn?.state, input.expectNewTurn);
  if (initial) return { outcome: initial, settledAtEvent: null };
  for (const [index, event] of input.events.entries()) {
    const outcome = applyEvent(tracker, event);
    if (outcome) return { outcome, settledAtEvent: index };
  }
  return { outcome: null, settledAtEvent: null };
}

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".input.json")).sort()) {
  const stem = file.replace(/\.input\.json$/, "");
  test(`turn tracking: ${stem}`, () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Case;
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${stem}.expected.json`), "utf8")) as Expected;
    const actual = runCase(input);
    console.log(stem, JSON.stringify(actual));
    assert.deepEqual(actual, expected);
  });
}
