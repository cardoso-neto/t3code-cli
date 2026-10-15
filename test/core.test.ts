import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelSelection } from "@t3tools/contracts";
import { parseDuration } from "../src/cli.ts";
import { checkpointAfterRun } from "../src/commands/lifecycle.ts";
import { titleFromPrompt } from "../src/commands/turns.ts";
import { pairingTokenFromUrl, selectEnvironment, type CredentialsFile } from "../src/credentials.ts";
import { UsageError } from "../src/errors.ts";
import { modelFromFlags, parseKeyValues, validateOptions, type ProviderModel } from "../src/model.ts";
import { pickUnique, type ThreadShell } from "../src/resolve.ts";
import { currentRun, finalAssistantText, pendingRequests, summarizeEvent, type Run, type StreamItem } from "../src/turn.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

type ModelSelectionInput = { instanceId?: string; model?: string; options?: string[]; inherited?: ModelSelection };

const RUNNERS: Record<string, (input: never) => unknown> = {
  modelSelection: ({ instanceId, model, options = [], inherited }: ModelSelectionInput) =>
    modelFromFlags({ values: { "instance-id": instanceId, model, option: options }, positionals: [] }, inherited),
  validateOptions: ({ model, options }: { model: ProviderModel; options: string[] }) => validateOptions(model, parseKeyValues("option", options)),
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
  ] as ThreadShell[];
  const keys = (thread: ThreadShell) => [thread.id, thread.title];
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

test("currentRun prefers the newest active run, else the newest run", () => {
  const run = (ordinal: number, status: Run["status"]) => ({ id: `r${ordinal}`, ordinal, status }) as Run;
  assert.equal(currentRun([run(1, "completed"), run(2, "queued"), run(3, "completed")])?.id, "r2");
  assert.equal(currentRun([run(1, "completed"), run(2, "failed")])?.id, "r2");
  assert.equal(currentRun([]), undefined);
});

test("pendingRequests joins open requests with their turn item", () => {
  const runtimeRequests = [
    { id: "q1", status: "resolved" },
    { id: "q2", status: "pending" },
  ];
  const turnItems = [{ type: "assistant_message" }, { type: "approval_request", requestId: "q1" }, { type: "approval_request", requestId: "q2", prompt: "Run ls?" }];
  const projection = { runtimeRequests, turnItems } as unknown as Parameters<typeof pendingRequests>[0];
  assert.deepEqual(pendingRequests(projection), [{ request: runtimeRequests[1], item: turnItems[2] }]);
});

test("finalAssistantText prefers the run's last assistant message", () => {
  const messages = [
    { role: "assistant", runId: "r1", text: "first" },
    { role: "assistant", runId: "r2", text: "other run" },
    { role: "user", runId: "r1", text: "question" },
  ] as unknown as Parameters<typeof finalAssistantText>[0]["messages"];
  assert.equal(finalAssistantText({ messages }, "r1"), "first");
  assert.equal(finalAssistantText({ messages }, null), "other run");
  assert.equal(finalAssistantText({ messages: [] }, "r1"), "");
});

test("summarizeEvent shows only final, non-empty messages", () => {
  const message = (text: string, streaming: boolean) =>
    ({ kind: "event", sequence: 1, event: { type: "message.updated", payload: { id: "m1", role: "assistant", text, runId: "r1", streaming } } }) as Extract<StreamItem, { kind: "event" }>;
  assert.equal(summarizeEvent(message("Hel", true)), null);
  assert.equal(summarizeEvent(message("", false)), null);
  assert.deepEqual(summarizeEvent(message("Hello", false)), { type: "message", role: "assistant", text: "Hello", runId: "r1", messageId: "m1" });
});

test("checkpointAfterRun: 0 is the scope's baseline, otherwise the run's ready checkpoint", () => {
  const checkpoints = [
    { id: "base", ordinalWithinScope: 0, appRunOrdinal: null, status: "ready" },
    { id: "after-1", ordinalWithinScope: 1, appRunOrdinal: 1, status: "ready" },
    { id: "after-2", ordinalWithinScope: 2, appRunOrdinal: 2, status: "pending" },
  ] as unknown as Parameters<typeof checkpointAfterRun>[0];
  assert.equal(checkpointAfterRun(checkpoints, 0)?.id, "base");
  assert.equal(checkpointAfterRun(checkpoints, 1)?.id, "after-1");
  assert.equal(checkpointAfterRun(checkpoints, 2), undefined);
  assert.equal(checkpointAfterRun(checkpoints, 3), undefined);
});
