import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelSelection, OrchestrationEvent, OrchestrationThreadActivity, OrchestrationThreadShell, ServerProviderModel } from "@t3tools/contracts";
import { parseDuration } from "../src/cli.ts";
import { titleFromPrompt } from "../src/commands/turns.ts";
import { pairingTokenFromUrl, selectEnvironment, type CredentialsFile } from "../src/credentials.ts";
import { UsageError } from "../src/errors.ts";
import { modelFromFlags, parseKeyValues, validateOptions } from "../src/model.ts";
import { pickUnique } from "../src/resolve.ts";
import { finalAssistantText, hasQueuedTurnStart, isAssistantTextFinal, pendingRequests, summarizeEvent } from "../src/turn.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

type ModelSelectionInput = { instanceId?: string; model?: string; options?: string[]; inherited?: ModelSelection };

const RUNNERS: Record<string, (input: never) => unknown> = {
  modelSelection: ({ instanceId, model, options = [], inherited }: ModelSelectionInput) =>
    modelFromFlags({ values: { "instance-id": instanceId, model, option: options }, positionals: [] }, inherited),
  validateOptions: ({ model, options }: { model: ServerProviderModel; options: string[] }) => validateOptions(model, parseKeyValues("option", options)),
  titleFromPrompt: ({ text }: { text: string }) => titleFromPrompt(text),
};

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".input.json")).sort()) {
  const stem = file.replace(/\.input\.json$/, "");
  test(`fixture: ${stem}`, () => {
    const { builder, input } = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as { builder: string; input: never };
    const expected: unknown = JSON.parse(readFileSync(join(FIXTURES, `${stem}.expected.json`), "utf8"));
    const run = RUNNERS[builder];
    assert.ok(run, `unknown builder ${builder}`);
    assert.deepEqual(run(input), expected);
  });
}

test("modelFromFlags: no flags inherits nothing", () => {
  assert.equal(modelFromFlags({ values: {}, positionals: [] }, { instanceId: "codex", model: "gpt" } as ModelSelection), undefined);
});

test("modelFromFlags: switching instance needs a model", () => {
  assert.throws(() => modelFromFlags({ values: { "instance-id": "claudeAgent" }, positionals: [] }, { instanceId: "codex", model: "gpt" } as ModelSelection), UsageError);
});

test("parseKeyValues rejects entries without =", () => {
  assert.throws(() => parseKeyValues("option", ["effort"]), UsageError);
  assert.deepEqual(parseKeyValues("answer", ["q=a=b"]), [{ id: "q", value: "a=b" }]);
});

test("pickUnique: exact beats prefix, ambiguity is an error", () => {
  const threads = [
    { id: "abc123", title: "Fix login" },
    { id: "abd456", title: "abc123-notes" },
  ] as OrchestrationThreadShell[];
  const keys = (thread: OrchestrationThreadShell) => [thread.id, thread.title];
  assert.deepEqual(pickUnique(threads, "abc123", "thread", keys), { found: threads[0] });
  assert.deepEqual(pickUnique(threads, "fix login", "thread", keys), { found: threads[0] });
  assert.match((pickUnique(threads, "ab", "thread", keys) as { error: string }).error, /matches 2 threads/);
  assert.match((pickUnique(threads, "zzz", "thread", keys) as { error: string }).error, /no thread matches/);
});

test("parseDuration", () => {
  assert.equal(parseDuration("90"), 90_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.throws(() => parseDuration("soon"), UsageError);
});

test("pairingTokenFromUrl reads the hash or the query", () => {
  assert.deepEqual(pairingTokenFromUrl("https://box.example:3773/pair#token=AB"), { origin: "https://box.example:3773", token: "AB" });
  assert.deepEqual(pairingTokenFromUrl("http://localhost:3773/pair?token=CD"), { origin: "http://localhost:3773", token: "CD" });
  assert.throws(() => pairingTokenFromUrl("http://localhost:3773/pair"), UsageError);
});

test("selectEnvironment: selector, then default, then first", () => {
  const env = (label: string) => ({ label, origin: `http://${label}`, accessToken: "t", expiresAt: null, scopes: [] });
  const file: CredentialsFile = { environments: { "env-a": env("laptop"), "env-b": env("server") }, default: "env-b" };
  assert.equal(selectEnvironment(file, "laptop")?.[0], "env-a");
  assert.equal(selectEnvironment(file, undefined)?.[0], "env-b");
  assert.equal(selectEnvironment({ environments: file.environments }, undefined)?.[0], "env-a");
  assert.equal(selectEnvironment({ environments: {} }, undefined), null);
  assert.throws(() => selectEnvironment(file, "nope"));
});

test("pendingRequests drops resolved requests", () => {
  const activity = (kind: string, requestId: string) => ({ kind, payload: { requestId } }) as unknown as OrchestrationThreadActivity;
  const open = activity("user-input.requested", "r2");
  assert.deepEqual(pendingRequests([activity("approval.requested", "r1"), open, activity("approval.resolved", "r1")]), [open]);
});

test("finalAssistantText prefers the turn's last assistant message", () => {
  const messages = [
    { role: "assistant", turnId: "t1", text: "first" },
    { role: "assistant", turnId: "t2", text: "other turn" },
    { role: "user", turnId: "t1", text: "question" },
  ] as unknown as Parameters<typeof finalAssistantText>[0]["messages"];
  assert.equal(finalAssistantText({ messages }, "t1"), "first");
  assert.equal(finalAssistantText({ messages }, null), "other turn");
  assert.equal(finalAssistantText({ messages: [] }, "t1"), "");
});

test("hasQueuedTurnStart: a recent user message no turn has adopted", () => {
  type Thread = Parameters<typeof hasQueuedTurnStart>[0];
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 13) + seconds * 1000).toISOString();
  const turn = (requestedAt: number) => ({ requestedAt: at(requestedAt), startedAt: null, completedAt: null }) as Thread["latestTurn"];
  const thread = (latestTurn: Thread["latestTurn"], status?: string) =>
    ({ messages: [{ id: "m1", role: "user", createdAt: at(0) }], latestTurn, session: status ? { status } : null }) as unknown as Thread;
  const now = Date.parse(at(5));
  assert.equal(hasQueuedTurnStart(thread(null), now), true);
  assert.equal(hasQueuedTurnStart(thread(turn(-60)), now), true);
  assert.equal(hasQueuedTurnStart(thread(turn(0)), now), false);
  assert.equal(hasQueuedTurnStart(thread(null, "error"), now), false);
  assert.equal(hasQueuedTurnStart(thread(null), Date.parse(at(180))), false);
  assert.equal(hasQueuedTurnStart({ ...thread(null), messages: [] }, now), false);
});

test("isAssistantTextFinal waits only on the turn's streaming assistant messages", () => {
  const messages = [
    { role: "assistant", turnId: "t1", streaming: false },
    { role: "assistant", turnId: "t2", streaming: true },
    { role: "user", turnId: "t1", streaming: true },
  ] as unknown as Parameters<typeof isAssistantTextFinal>[0]["messages"];
  assert.equal(isAssistantTextFinal({ messages }, "t1"), true);
  assert.equal(isAssistantTextFinal({ messages }, "t2"), false);
});

test("summarizeEvent joins streamed deltas until the final message", () => {
  const message = (text: string, streaming: boolean) =>
    ({ type: "thread.message-sent", payload: { messageId: "m1", role: "assistant", text, turnId: "t1", streaming } }) as OrchestrationEvent;
  const streaming = new Map<string, string>();
  assert.equal(summarizeEvent(message("Hel", true), streaming), null);
  assert.equal(summarizeEvent(message("lo", true), streaming), null);
  assert.deepEqual(summarizeEvent(message("", false), streaming), { type: "message", role: "assistant", text: "Hello", turnId: "t1", messageId: "m1" });
  assert.equal(streaming.size, 0);
});
