import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildBootstrapTurnStart, buildProjectCommand, buildThreadCommand, buildThreadCreate, buildTurnStart, titleFromPrompt } from "../src/payloads.ts";
import { buildModelSelection, parseOptionFlags, validateOptions } from "../src/model.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const IDS = { commandId: "cmd-1", threadId: "thread-1", messageId: "msg-1", createdAt: "2026-09-13T00:00:00.000Z" };

type Case = { builder: string; input: Record<string, unknown> };

const BUILDERS: Record<string, (input: Record<string, unknown>) => unknown> = {
  threadCreate: (input) => buildThreadCreate(input.thread as never, IDS),
  turnStart: (input) => buildTurnStart(input.threadId as string, input.turn as never, IDS),
  bootstrapTurnStart: (input) => buildBootstrapTurnStart(input.thread as never, input.turn as never, IDS),
  threadCommand: (input) => buildThreadCommand(input.type as never, input.threadId as string, (input.fields ?? {}) as never, IDS),
  projectCommand: (input) => buildProjectCommand(input.type as never, input.fields as never, IDS),
  modelSelection: (input) => buildModelSelection({ options: parseOptionFlags((input.options as string[]) ?? []), ...(input.instanceId ? { instanceId: input.instanceId as string } : {}), ...(input.model ? { model: input.model as string } : {}) }, (input.inherited as never) ?? null),
  validateOptions: (input) => validateOptions(input.model as never, parseOptionFlags(input.options as string[])),
  titleFromPrompt: (input) => titleFromPrompt(input.text as string),
};

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".input.json")).sort()) {
  const stem = file.replace(/\.input\.json$/, "");
  test(`payload fixture: ${stem}`, () => {
    const { builder, input } = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Case;
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${stem}.expected.json`), "utf8")) as unknown;
    const actual = BUILDERS[builder]!(input);
    console.log(stem, JSON.stringify(actual));
    assert.deepEqual(actual, expected);
  });
}

test("parseOptionFlags rejects entries without =", () => {
  assert.throws(() => parseOptionFlags(["reasoningEffort"]), /id=value/);
});

test("buildModelSelection needs instanceId and model when nothing is inherited", () => {
  assert.throws(() => buildModelSelection({ instanceId: "codex", options: [] }, null), /--instance-id and --model/);
});
