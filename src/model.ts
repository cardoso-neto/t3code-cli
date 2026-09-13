import { T3Error } from "./client.ts";
import type { ModelSelection, Provider, ProviderModel, ProviderOptionDescriptor, ProviderOptionSelection } from "./contracts.ts";

export function parseOptionFlags(entries: string[]): ProviderOptionSelection[] {
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new T3Error(`--option expects id=value, got "${entry}"`, 64);
    const id = entry.slice(0, separator);
    const raw = entry.slice(separator + 1);
    const value = raw === "true" ? true : raw === "false" ? false : raw;
    return { id, value };
  });
}

export type ModelFlags = { instanceId?: string; model?: string; options: ProviderOptionSelection[] };

export function buildModelSelection(flags: ModelFlags, inherited: ModelSelection | null): ModelSelection | undefined {
  if (!flags.instanceId && !flags.model && flags.options.length === 0) return inherited ?? undefined;
  const instanceId = flags.instanceId ?? inherited?.instanceId;
  const model = flags.model ?? (flags.instanceId && flags.instanceId !== inherited?.instanceId ? undefined : inherited?.model);
  if (!instanceId || !model) {
    throw new T3Error("model selection needs both --instance-id and --model (see: t3c models)", 64);
  }
  const options = flags.options.length > 0 ? flags.options : inherited?.instanceId === instanceId && inherited.model === model ? inherited.options : undefined;
  return options && options.length > 0 ? { instanceId, model, options } : { instanceId, model };
}

export function findModel(providers: Provider[], selection: ModelSelection): { provider: Provider; model: ProviderModel } {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!provider) throw new T3Error(`unknown provider instance "${selection.instanceId}"; known: ${providers.map((p) => p.instanceId).join(", ")}`);
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) throw new T3Error(`provider "${provider.instanceId}" has no model "${selection.model}"; known: ${provider.models.map((m) => m.slug).join(", ")}`);
  return { provider, model };
}

export function validateOptions(model: ProviderModel, options: ProviderOptionSelection[]): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const problems: string[] = [];
  for (const option of options) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) {
      problems.push(`option "${option.id}" is not offered by ${model.slug}; offered: ${descriptors.map((d) => d.id).join(", ") || "none"}`);
      continue;
    }
    const problem = describeOptionMismatch(descriptor, option.value);
    if (problem) problems.push(problem);
  }
  return problems;
}

function describeOptionMismatch(descriptor: ProviderOptionDescriptor, value: string | boolean): string | null {
  if (descriptor.type === "boolean") return typeof value === "boolean" ? null : `option "${descriptor.id}" expects true or false`;
  const allowed = descriptor.options.map((choice) => choice.id);
  return allowed.includes(String(value)) ? null : `option "${descriptor.id}" must be one of ${allowed.join(", ")}`;
}

export function describeModel(provider: Provider, model: ProviderModel): Record<string, unknown> {
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    name: model.name,
    default: model.isDefault === true,
    legacy: model.isLegacy === true,
    options: (model.capabilities?.optionDescriptors ?? []).map((descriptor) =>
      descriptor.type === "boolean"
        ? { id: descriptor.id, type: "boolean" }
        : {
            id: descriptor.id,
            type: "select",
            values: descriptor.options.map((choice) => choice.id),
            default: descriptor.options.find((choice) => choice.isDefault)?.id,
          },
    ),
  };
}
