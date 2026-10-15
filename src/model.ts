import type { ModelSelection, ProviderOptionSelection } from "@t3tools/contracts";
import { listFlag, stringFlag, type ParsedArgs } from "./cli.ts";
import type { RpcOutput, T3Client, Wire } from "./client.ts";
import { T3Error, UsageError } from "./errors.ts";

export type Provider = RpcOutput<"server.getConfig">["providers"][number];
export type ProviderModel = Provider["models"][number];
type OptionDescriptor = NonNullable<NonNullable<ProviderModel["capabilities"]>["optionDescriptors"]>[number];

export const MODEL_FLAGS = {
  "instance-id": { type: "string", value: "id", help: "provider instance, e.g. codex, claudeAgent (see: t3c providers)" },
  model: { type: "string", value: "slug", help: "model slug (see: t3c models)" },
  option: { type: "string", value: "id=value", multiple: true, help: "provider option, repeatable, e.g. reasoningEffort=high, effort=max, fastMode=true" },
  "no-validate": { type: "boolean", help: "skip checking --option against the model's descriptors" },
} as const;

/** `id=value` pairs; `true` and `false` become booleans. Shared by --option and --answer. */
export function parseKeyValues(flag: string, entries: string[]): ProviderOptionSelection[] {
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new UsageError(`--${flag} expects id=value, got "${entry}"`);
    const raw = entry.slice(separator + 1);
    return { id: entry.slice(0, separator), value: raw === "true" ? true : raw === "false" ? false : raw };
  });
}

/**
 * The selection --instance-id, --model, and --option ask for, filled in from `inherited`.
 * Undefined when none of those flags were given.
 */
export function modelFromFlags(args: ParsedArgs, wireInherited: Wire<typeof ModelSelection> | null | undefined): ModelSelection | undefined {
  // Selections the server sends are canonical; the wire schema also admits a legacy `{ provider }` form on input.
  const inherited = wireInherited as ModelSelection | null | undefined;
  const instanceIdFlag = stringFlag(args, "instance-id");
  const modelFlag = stringFlag(args, "model");
  const optionFlags = parseKeyValues("option", listFlag(args, "option"));
  if (!instanceIdFlag && !modelFlag && optionFlags.length === 0) return undefined;
  const instanceId = (instanceIdFlag ?? inherited?.instanceId) as ModelSelection["instanceId"] | undefined;
  const switchedInstance = instanceIdFlag !== undefined && instanceIdFlag !== inherited?.instanceId;
  const model = modelFlag ?? (switchedInstance ? undefined : inherited?.model);
  if (!instanceId || !model) throw new UsageError("model selection needs both --instance-id and --model (see: t3c models)");
  const sameModel = inherited?.instanceId === instanceId && inherited.model === model;
  const options = optionFlags.length > 0 ? optionFlags : sameModel ? inherited.options : undefined;
  return options?.length ? { instanceId, model, options } : { instanceId, model };
}

export function findModel(providers: readonly Provider[], selection: ModelSelection): { provider: Provider; model: ProviderModel } {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!provider) throw new T3Error(`unknown provider instance "${selection.instanceId}"; known: ${providers.map((p) => p.instanceId).join(", ")}`);
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) throw new T3Error(`provider "${provider.instanceId}" has no model "${selection.model}"; known: ${provider.models.map((m) => m.slug).join(", ")}`);
  return { provider, model };
}

/** Problems with `options` against the model's descriptors; empty when valid. */
export function validateOptions(model: ProviderModel, options: readonly ProviderOptionSelection[]): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  return options.flatMap((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) return [`option "${option.id}" is not offered by ${model.slug}; offered: ${descriptors.map((d) => d.id).join(", ") || "none"}`];
    const problem = describeOptionMismatch(descriptor, option.value);
    return problem ? [problem] : [];
  });
}

function describeOptionMismatch(descriptor: OptionDescriptor, value: string | boolean): string | null {
  if (descriptor.type === "boolean") return typeof value === "boolean" ? null : `option "${descriptor.id}" expects true or false`;
  const allowed = descriptor.options.map((choice) => choice.id);
  return allowed.includes(String(value)) ? null : `option "${descriptor.id}" must be one of ${allowed.join(", ")}`;
}

/** Checks the selection against the server's catalog. Returns the provider so callers can inspect its capabilities. */
export async function checkModel(client: T3Client, selection: ModelSelection): Promise<Provider> {
  const { provider, model } = findModel((await client.call("server.getConfig", {})).providers, selection);
  const problems = validateOptions(model, selection.options ?? []);
  if (problems.length) throw new UsageError(`${problems.join("\n")}\n(pass --no-validate to send anyway)`);
  return provider;
}

export function describeOptions(model: ProviderModel): string[] {
  return (model.capabilities?.optionDescriptors ?? []).map((descriptor) =>
    descriptor.type === "boolean"
      ? `${descriptor.id}=true|false`
      : `${descriptor.id}=${descriptor.options.map((choice) => choice.id).join("|")}${descriptor.options.some((choice) => choice.isDefault) ? ` (default ${descriptor.options.find((choice) => choice.isDefault)!.id})` : ""}`,
  );
}
