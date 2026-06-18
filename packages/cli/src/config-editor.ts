/**
 * Shared configuration editing helpers for all interactive surfaces.
 *
 * The terminal TUI and the Web UI both edit ~/.claudish/config.json. Keeping
 * these writes here prevents the two frontends from drifting into subtly
 * different behavior.
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DefaultProviderSource, resolveDefaultProvider } from "./default-provider.js";
import {
  type ClaudishProfileConfig,
  loadConfig,
  removeApiKey,
  saveConfig,
} from "./profile-config.js";
import {
  type ProviderDefinition,
  getAllProviders,
  getProviderByName,
} from "./providers/provider-definitions.js";

export type CustomProviderFormat = "openai" | "anthropic" | "gemini";

export type EffectiveValueSource =
  | "cli-flag"
  | "env-var"
  | "config-file"
  | "anthropic-env-var"
  | "openrouter-key"
  | "hardcoded"
  | "unset";

export interface GeneralDefaultsInput {
  defaultModel?: string;
  defaultProvider?: string;
}

export interface SimpleCustomProviderInput {
  providerId: string;
  format: CustomProviderFormat;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  models?: string[] | string;
}

export interface BuiltinProviderModelsInput {
  providerId: string;
  apiKey?: string;
  defaultModel?: string;
  models?: string[] | string;
}

export interface CustomProviderSummary {
  id: string;
  source: "custom" | "builtin";
  credentialSource?: "config-api-key" | "env-var" | "oauth-file";
  authMode?: "api-key" | "oauth";
  typeLabel?: string;
  kind: "simple" | "complex" | "invalid";
  displayName: string;
  format?: CustomProviderFormat;
  transport?: string;
  baseUrl?: string;
  apiKey: string;
  defaultModel?: string;
  models: string[];
  error?: string;
  authFile?: string;
}

export interface ConfigEditorState {
  configDefaults: {
    defaultModel?: string;
    defaultProvider?: string;
  };
  effectiveDefaultModel: {
    value?: string;
    source: EffectiveValueSource;
  };
  effectiveDefaultProvider: {
    value: string;
    source: DefaultProviderSource;
  };
  modelOptions: string[];
  modelOptionsByProvider: Record<string, string[]>;
  providerOptions: string[];
  customProviders: CustomProviderSummary[];
}

/**
 * Small offline model list used by the Web UI before any remote catalog loads.
 */
const COMMON_MODEL_OPTIONS = [
  "cx@gpt-5.5",
  "cx@gpt-5-codex",
  "g@gemini-3.1-pro-preview",
  "g@gemini-2.5-flash",
  "openrouter@anthropic/claude-sonnet-4",
  "openrouter@openai/gpt-5",
  "openai@gpt-4o",
  "kimi@kimi-k2.5",
  "zai@glm-4.6",
  "zen@glm-5",
];

/**
 * Normalize user-facing provider ids to the canonical custom endpoint key.
 */
export function normalizeCustomProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

/**
 * Validate the custom provider id before writing it into config.json.
 */
export function assertValidCustomProviderId(providerId: string): string {
  const normalized = normalizeCustomProviderId(providerId);
  if (!normalized) {
    throw new Error("provider-id is required");
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Use lowercase letters, numbers, '-' or '_', and start with a letter");
  }
  if (getProviderByName(normalized)) {
    throw new Error(`Provider '${normalized}' is already built in; choose another provider-id`);
  }
  return normalized;
}

/**
 * Validate and normalize an HTTP(S) endpoint URL.
 */
export function normalizeEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid base_url, for example https://api.example.com/v1");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base_url must start with http:// or https://");
  }

  return trimmed.replace(/\/+$/, "");
}

/**
 * Persist the top-level default model and default provider.
 */
export function saveGeneralDefaults(input: GeneralDefaultsInput): ClaudishProfileConfig {
  const config = loadConfig();
  const { defaultModel, defaultProvider } = normalizeGeneralDefaults(input);

  if (defaultModel) config.defaultModel = defaultModel;
  else config.defaultModel = undefined;

  if (defaultProvider) config.defaultProvider = defaultProvider;
  else config.defaultProvider = undefined;

  saveConfig(config);
  return config;
}

/**
 * Return the saved secret for one custom provider when the user explicitly
 * reveals it in the localhost-only Web UI.
 */
export function getCustomProviderSecret(providerId: string): string | undefined {
  const normalized = normalizeCustomProviderId(providerId);
  const config = loadConfig();
  const builtin = findBuiltinProvider(normalized);
  if (builtin) {
    const credential = builtinCredentialSource(config, builtin);
    return credential?.source === "config-api-key" ? credential.value : undefined;
  }

  const apiKey = readExistingCustomProviderApiKey(config, normalized);
  return apiKey || undefined;
}

/**
 * Persist a simple custom provider endpoint.
 */
export function saveSimpleCustomProvider(input: SimpleCustomProviderInput): ClaudishProfileConfig {
  const providerId = assertValidCustomProviderId(input.providerId);
  const apiKey = input.apiKey.trim();
  const config = loadConfig();
  const existingApiKey = readExistingCustomProviderApiKey(config, providerId);
  if (!apiKey && !existingApiKey) {
    throw new Error("api-key is required");
  }

  const defaultModel = input.defaultModel?.trim() ?? "";
  const models = normalizeProviderModels(input.models, defaultModel);
  config.customEndpoints = {
    ...(config.customEndpoints ?? {}),
    [providerId]: {
      kind: "simple",
      url: normalizeEndpointUrl(input.baseUrl),
      format: input.format,
      apiKey: apiKey || existingApiKey,
      ...(defaultModel ? { defaultModel } : {}),
      ...(models.length > 0 ? { models } : {}),
    },
  };

  saveConfig(config);
  return config;
}

/**
 * Persist editable model metadata for a builtin provider without changing its transport.
 */
export function saveBuiltinProviderModels(
  input: BuiltinProviderModelsInput
): ClaudishProfileConfig {
  const providerId = normalizeCustomProviderId(input.providerId);
  const provider = findBuiltinProvider(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' is not a builtin provider`);
  }

  const summaryId = provider.shortestPrefix || provider.name;
  const defaultModel = input.defaultModel?.trim() ?? "";
  const apiKey = input.apiKey?.trim() ?? "";
  const models = normalizeProviderModels(input.models, defaultModel);
  const config = loadConfig();
  const nextModels = { ...(config.builtinProviderModels ?? {}) };

  if (models.length > 0) nextModels[summaryId] = models;
  else delete nextModels[summaryId];

  // Builtin API-key providers keep their transport fixed, but a typed key can
  // still refresh the stored credential used by the transport.
  if (apiKey && provider.apiKeyEnvVar) {
    config.apiKeys = { ...(config.apiKeys ?? {}), [provider.apiKeyEnvVar]: apiKey };
  }

  config.builtinProviderModels = Object.keys(nextModels).length > 0 ? nextModels : undefined;
  saveConfig(config);
  return config;
}

/**
 * Delete a custom provider endpoint by id.
 */
export function deleteCustomProvider(providerId: string): boolean {
  const normalized = normalizeCustomProviderId(providerId);
  const config = loadConfig();
  const builtin = findBuiltinProvider(normalized);

  if (builtin) {
    return deleteBuiltinProviderCredentials(config, normalized, builtin);
  }

  if (!config.customEndpoints || !(normalized in config.customEndpoints)) {
    return false;
  }

  const remaining = omitRecordKey(config.customEndpoints, normalized);
  config.customEndpoints = Object.keys(remaining).length > 0 ? remaining : undefined;

  // Avoid leaving a defaultProvider that points at a deleted custom endpoint.
  if (config.defaultProvider === normalized) {
    config.defaultProvider = undefined;
  }

  saveConfig(config);
  return true;
}

/**
 * Build a frontend-friendly snapshot of the current editable configuration.
 */
export function getConfigEditorState(env: NodeJS.ProcessEnv = process.env): ConfigEditorState {
  const config = migrateCustomProviderModels(loadConfig());
  const configDefaults = normalizeGeneralDefaults({
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  });
  const effectiveDefaultModel = resolveEffectiveDefaultModel(config, env);
  const effectiveDefaultProvider = resolveEffectiveDefaultProvider(
    config,
    env,
    effectiveDefaultModel
  );

  return {
    configDefaults: {
      defaultModel: optionalDefaultValue(configDefaults.defaultModel),
      defaultProvider: optionalDefaultValue(configDefaults.defaultProvider),
    },
    effectiveDefaultModel: normalizeEffectiveDefaultModel(effectiveDefaultModel),
    effectiveDefaultProvider,
    modelOptions: buildModelOptions(config),
    modelOptionsByProvider: buildModelOptionsByProvider(config),
    providerOptions: buildProviderOptions(config),
    customProviders: summarizeConfiguredProviders(config),
  };
}

/**
 * Read a saved custom provider key so edits can leave the key field blank.
 */
function readExistingCustomProviderApiKey(
  config: ClaudishProfileConfig,
  providerId: string
): string {
  const existing = config.customEndpoints?.[providerId];
  if (!existing || typeof existing !== "object") return "";

  const entry = existing as Record<string, unknown>;
  return typeof entry.apiKey === "string" ? entry.apiKey : "";
}

/**
 * Normalize default form input while treating provider@model as a selection
 * that fills both saved config fields.
 */
function normalizeGeneralDefaults(input: GeneralDefaultsInput): Required<GeneralDefaultsInput> {
  const defaultModel = input.defaultModel?.trim() ?? "";
  const defaultProvider = input.defaultProvider?.trim() ?? "";
  const selectedSpec = splitProviderModelSpec(defaultModel);

  if (selectedSpec) {
    return {
      defaultProvider: selectedSpec.provider,
      defaultModel: selectedSpec.model,
    };
  }

  return { defaultModel, defaultProvider };
}

/**
 * Split the user-facing provider@model picker value without canonicalizing the
 * provider shortcut, so values such as cx@gpt-5.5 persist as provider "cx".
 */
function splitProviderModelSpec(value: string): { provider: string; model: string } | undefined {
  const atIndex = value.indexOf("@");
  if (atIndex <= 0 || atIndex === value.length - 1) return undefined;
  return {
    provider: value.slice(0, atIndex).trim(),
    model: value.slice(atIndex + 1).trim(),
  };
}

/**
 * Convert empty normalized defaults back to omitted JSON state fields.
 */
function optionalDefaultValue(value: string): string | undefined {
  return value || undefined;
}

/**
 * Display the effective model without the provider prefix when the provider is
 * already reported separately.
 */
function normalizeEffectiveDefaultModel(
  effective: ConfigEditorState["effectiveDefaultModel"]
): ConfigEditorState["effectiveDefaultModel"] {
  const split = splitProviderModelSpec(effective.value ?? "");
  return split ? { value: split.model, source: effective.source } : effective;
}

/**
 * Display the provider encoded in an explicit provider@model default before
 * falling back to the regular default-provider resolver.
 */
function resolveEffectiveDefaultProvider(
  config: ClaudishProfileConfig,
  env: NodeJS.ProcessEnv,
  effectiveModel: ConfigEditorState["effectiveDefaultModel"]
): ConfigEditorState["effectiveDefaultProvider"] {
  const split = splitProviderModelSpec(effectiveModel.value ?? "");
  if (split) {
    return {
      value: split.provider,
      source: modelSourceToProviderSource(effectiveModel.source),
    };
  }

  const resolved = resolveDefaultProvider({ config, env });
  return { value: resolved.provider, source: resolved.source };
}

/**
 * Reuse compatible source labels when an explicit model also selects provider.
 */
function modelSourceToProviderSource(source: EffectiveValueSource): DefaultProviderSource {
  return source === "config-file" ? "config-file" : "env-var";
}

/**
 * Build model suggestions from stable defaults and the user's config.
 */
function buildModelOptions(config: ClaudishProfileConfig): string[] {
  const options = new Set<string>();

  // Put user-configured values first because they are most likely to be reused.
  addOption(options, config.defaultModel);
  for (const provider of summarizeConfiguredProviders(config)) {
    for (const model of provider.models) {
      addOption(options, `${provider.id}@${model}`);
    }
  }
  for (const model of COMMON_MODEL_OPTIONS) {
    addOption(options, model);
  }

  return [...options];
}

/**
 * Build provider-scoped bare model suggestions for paired provider/model fields.
 */
function buildModelOptionsByProvider(config: ClaudishProfileConfig): Record<string, string[]> {
  const options = new Map<string, Set<string>>();
  const defaults = normalizeGeneralDefaults({
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  });

  addProviderModelOptions(options, defaults.defaultProvider, defaults.defaultModel);
  for (const provider of summarizeConfiguredProviders(config)) {
    for (const model of provider.models) {
      addProviderModelOptions(options, provider.id, model);
    }
  }
  for (const value of COMMON_MODEL_OPTIONS) {
    const split = splitProviderModelSpec(value);
    if (split) addProviderModelOptions(options, split.provider, split.model);
  }

  return Object.fromEntries(
    [...options.entries()].map(([provider, models]) => [provider, [...models]])
  );
}

/**
 * Add one bare model under every known name/shortcut for a provider.
 */
function addProviderModelOptions(
  options: Map<string, Set<string>>,
  providerId?: string,
  model?: string
): void {
  const provider = providerId?.trim();
  const bareModel = model?.trim();
  if (!provider || !bareModel) return;

  for (const providerKey of providerOptionKeys(provider)) {
    let models = options.get(providerKey);
    if (!models) {
      models = new Set<string>();
      options.set(providerKey, models);
    }
    models.add(bareModel);
  }
}

/**
 * Return the provider id plus built-in aliases so either cx or openai-codex works.
 */
function providerOptionKeys(providerId: string): string[] {
  const provider = getAllProviders().find(
    (entry) =>
      entry.name === providerId ||
      entry.shortestPrefix === providerId ||
      entry.shortcuts?.includes(providerId)
  );
  if (!provider) return [providerId];

  const keys = new Set<string>();
  addOption(keys, providerId);
  addOption(keys, provider.name);
  addOption(keys, provider.shortestPrefix);
  for (const shortcut of provider.shortcuts ?? []) {
    addOption(keys, shortcut);
  }
  return [...keys];
}

/**
 * Build provider suggestions from built-ins plus custom endpoints.
 */
function buildProviderOptions(config: ClaudishProfileConfig): string[] {
  const options = new Set<string>();

  // The saved default comes first so keyboard users hit their current choice quickly.
  addOption(options, config.defaultProvider);
  for (const provider of getAllProviders()) {
    addOption(options, provider.shortestPrefix);
    addOption(options, provider.name);
  }
  for (const providerId of Object.keys(config.customEndpoints ?? {})) {
    addOption(options, providerId);
  }

  return [...options];
}

/**
 * Add a non-empty string to an option set after trimming browser form input.
 */
function addOption(options: Set<string>, value?: string): void {
  const trimmed = value?.trim();
  if (trimmed) options.add(trimmed);
}

/**
 * Resolve the model users will get when they do not pass --model.
 */
function resolveEffectiveDefaultModel(
  config: ClaudishProfileConfig,
  env: NodeJS.ProcessEnv
): ConfigEditorState["effectiveDefaultModel"] {
  if (env.CLAUDISH_MODEL) {
    return { value: env.CLAUDISH_MODEL, source: "env-var" };
  }
  if (config.defaultModel) {
    return { value: config.defaultModel, source: "config-file" };
  }
  if (env.ANTHROPIC_MODEL) {
    return { value: env.ANTHROPIC_MODEL, source: "anthropic-env-var" };
  }
  return { value: undefined, source: "unset" };
}

/**
 * Convert configured custom and builtin providers into rows a UI can render directly.
 */
function summarizeConfiguredProviders(config: ClaudishProfileConfig): CustomProviderSummary[] {
  const customProviders = Object.entries(config.customEndpoints ?? {}).map(([id, value]) =>
    summarizeCustomProvider(id, value)
  );
  const customIds = new Set(customProviders.map((provider) => provider.id));
  return [
    ...customProviders,
    ...summarizeConfiguredBuiltinProviders(config).filter(
      (provider) => !customIds.has(provider.id)
    ),
  ];
}

/**
 * Convert one raw custom endpoint entry into a UI summary row.
 */
function summarizeCustomProvider(id: string, value: unknown): CustomProviderSummary {
  if (!value || typeof value !== "object") {
    return invalidCustomProvider(id, "", "Custom provider entry must be an object");
  }

  const entry = value as Record<string, unknown>;
  if (entry.kind === "simple") {
    return summarizeSimpleCustomProvider(id, entry);
  }

  if (entry.kind === "complex") {
    return summarizeComplexCustomProvider(id, entry);
  }

  return invalidCustomProvider(
    id,
    typeof entry.apiKey === "string" ? entry.apiKey : "",
    "Custom provider kind must be simple or complex"
  );
}

/**
 * Convert a simple custom endpoint into a UI summary row.
 */
function summarizeSimpleCustomProvider(
  id: string,
  entry: Record<string, unknown>
): CustomProviderSummary {
  const defaultModel = typeof entry.defaultModel === "string" ? entry.defaultModel : undefined;
  return {
    id,
    source: "custom",
    kind: "simple",
    displayName: id,
    format: isCustomProviderFormat(entry.format) ? entry.format : undefined,
    baseUrl: typeof entry.url === "string" ? entry.url : undefined,
    apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
    defaultModel,
    models: normalizeProviderModels(entry.models, defaultModel),
  };
}

/**
 * Convert a complex custom endpoint into a UI summary row.
 */
function summarizeComplexCustomProvider(
  id: string,
  entry: Record<string, unknown>
): CustomProviderSummary {
  return {
    id,
    source: "custom",
    kind: "complex",
    displayName: typeof entry.displayName === "string" ? entry.displayName : id,
    transport: typeof entry.transport === "string" ? entry.transport : undefined,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : undefined,
    apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
    defaultModel: undefined,
    models: normalizeProviderModels(entry.models),
  };
}

/**
 * Build a summary row for invalid custom endpoint entries.
 */
function invalidCustomProvider(id: string, apiKey: string, error: string): CustomProviderSummary {
  return {
    id,
    source: "custom",
    kind: "invalid",
    displayName: id,
    apiKey,
    models: [],
    error,
  };
}

/**
 * Build rows for builtin providers only after the user has configured auth.
 */
function summarizeConfiguredBuiltinProviders(
  config: ClaudishProfileConfig
): CustomProviderSummary[] {
  const providers: CustomProviderSummary[] = [];
  for (const provider of getAllProviders()) {
    const credential = builtinCredentialSource(config, provider);
    if (!credential) continue;
    providers.push(summarizeConfiguredBuiltinProvider(provider, config, credential));
  }
  return providers;
}

/**
 * Convert one configured builtin provider definition into the shared UI row.
 */
function summarizeConfiguredBuiltinProvider(
  provider: ProviderDefinition,
  config: ClaudishProfileConfig,
  credential: NonNullable<ReturnType<typeof builtinCredentialSource>>
): CustomProviderSummary {
  const id = provider.shortestPrefix || provider.name;
  const authMode = builtinProviderAuthMode(provider, credential);
  const models = builtinProviderModels(config, id);
  return {
    id,
    source: "builtin",
    credentialSource: credential.source,
    authMode,
    typeLabel: builtinProviderTypeLabel(provider, authMode),
    kind: "simple",
    displayName: provider.displayName,
    format: builtinProviderFormat(provider),
    transport: provider.transport,
    ...(authMode === "oauth" ? {} : { baseUrl: provider.baseUrl }),
    apiKey: credential.source === "config-api-key" ? credential.value : "",
    defaultModel: models[0],
    models,
    authFile: credential.authFile,
  };
}

/**
 * Treat Codex as OAuth in the editor even if an env var is also present.
 */
function builtinProviderAuthMode(
  provider: ProviderDefinition,
  credential: NonNullable<ReturnType<typeof builtinCredentialSource>>
): "api-key" | "oauth" {
  if (provider.name === "openai-codex" || credential.source === "oauth-file") return "oauth";
  return "api-key";
}

/**
 * Return the human-facing type label used in provider tables and modals.
 */
function builtinProviderTypeLabel(
  provider: ProviderDefinition,
  authMode: "api-key" | "oauth"
): string {
  if (provider.name === "openai-codex" && authMode === "oauth") return "Codex-Oauth";
  return builtinProviderFormat(provider);
}

/**
 * Collapse builtin transport variants into the simple endpoint formats the UI knows.
 */
function builtinProviderFormat(provider: ProviderDefinition): CustomProviderFormat {
  if (provider.transport === "gemini" || provider.transport === "gemini-oauth") return "gemini";
  if (provider.transport === "anthropic") return "anthropic";
  return "openai";
}

/**
 * Resolve whether a builtin provider has user-supplied credentials.
 */
function builtinCredentialSource(
  config: ClaudishProfileConfig,
  provider: ProviderDefinition
):
  | { source: "config-api-key"; value: string; envVar: string }
  | { source: "env-var"; value: string; envVar: string }
  | { source: "oauth-file"; authFile: string }
  | undefined {
  const apiKeyEnvVars = builtinApiKeyEnvVars(provider);
  for (const envVar of apiKeyEnvVars) {
    const value = config.apiKeys?.[envVar];
    if (value) return { source: "config-api-key", value, envVar };
  }
  for (const envVar of apiKeyEnvVars) {
    const value = process.env[envVar];
    if (value) return { source: "env-var", value, envVar };
  }
  const authFile = builtinOAuthPath(provider);
  if (authFile && existsSync(authFile)) return { source: "oauth-file", authFile };
  return undefined;
}

/**
 * Return the primary and alias env vars that can provide a builtin API key.
 */
function builtinApiKeyEnvVars(provider: ProviderDefinition): string[] {
  return [provider.apiKeyEnvVar, ...(provider.apiKeyAliases ?? [])].filter(Boolean);
}

/**
 * Resolve OAuth fallback paths with the same CLAUDISH_HOME convention as auth managers.
 */
function builtinOAuthPath(provider: ProviderDefinition): string | undefined {
  if (!provider.oauthFallback) return undefined;
  return join(process.env.CLAUDISH_HOME || join(homedir(), ".claudish"), provider.oauthFallback);
}

/**
 * Choose stable builtin model rows from the offline provider@model suggestions.
 */
function builtinProviderModels(config: ClaudishProfileConfig, providerId: string): string[] {
  const configured = normalizeProviderModels(config.builtinProviderModels?.[providerId]);
  if (configured.length > 0) return configured;

  const models = COMMON_MODEL_OPTIONS.flatMap((value) => {
    const split = splitProviderModelSpec(value);
    return split && providerOptionKeys(split.provider).includes(providerId) ? [split.model] : [];
  });
  return models.length > 0 ? [...new Set(models)] : [];
}

/**
 * Find a builtin provider by canonical name or shortcut.
 */
function findBuiltinProvider(providerId: string): ProviderDefinition | undefined {
  return getAllProviders().find(
    (provider) =>
      provider.name === providerId ||
      provider.shortestPrefix === providerId ||
      provider.shortcuts?.includes(providerId)
  );
}

/**
 * Match a saved provider value against every public id for the builtin provider.
 */
function providerMatchesBuiltinId(
  value: string | undefined,
  provider: ProviderDefinition
): boolean {
  if (!value) return false;
  return providerOptionKeys(value).some(
    (key) => key === provider.name || key === provider.shortestPrefix
  );
}

/**
 * Clear local credentials for a builtin provider; env-backed credentials cannot be removed here.
 */
function deleteBuiltinProviderCredentials(
  config: ClaudishProfileConfig,
  providerId: string,
  provider: ProviderDefinition
): boolean {
  const credential = builtinCredentialSource(config, provider);
  if (!credential) return false;
  if (credential.source === "env-var") {
    throw new Error(
      `Provider '${providerId}' is configured by environment variable ${credential.envVar}; unset it outside Claudish.`
    );
  }

  if (credential.source === "config-api-key") {
    removeApiKey(credential.envVar);
  } else {
    unlinkSync(credential.authFile);
  }

  if (providerMatchesBuiltinId(config.defaultProvider, provider)) {
    const updated = loadConfig();
    updated.defaultProvider = undefined;
    saveConfig(updated);
  }
  return true;
}

/**
 * Persist missing/dirty model lists so legacy one-model providers become the
 * new explicit multi-model shape the first time the editor reads them.
 */
function migrateCustomProviderModels(config: ClaudishProfileConfig): ClaudishProfileConfig {
  if (!config.customEndpoints) return config;

  let changed = false;
  const customEndpoints: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(config.customEndpoints)) {
    if (!value || typeof value !== "object") {
      customEndpoints[id] = value;
      continue;
    }

    const entry = value as Record<string, unknown>;
    const defaultModel = typeof entry.defaultModel === "string" ? entry.defaultModel : undefined;
    const models = normalizeProviderModels(entry.models, defaultModel);
    const normalizedEntry = { ...entry, ...(models.length > 0 ? { models } : {}) };

    if (!sameStringArray(entry.models, models)) {
      changed = true;
      customEndpoints[id] = normalizedEntry;
    } else {
      customEndpoints[id] = value;
    }
  }

  if (!changed) return config;
  const migrated = { ...config, customEndpoints };
  saveConfig(migrated);
  return migrated;
}

/**
 * Normalize provider model lists from JSON arrays or textarea strings while
 * ensuring the default model is always selectable.
 */
function normalizeProviderModels(modelsInput?: unknown, defaultModel?: string): string[] {
  const models = new Set<string>();
  const defaultBareModel = bareProviderModel(defaultModel);
  if (defaultBareModel) models.add(defaultBareModel);

  for (const model of rawModelValues(modelsInput)) {
    const bareModel = bareProviderModel(model);
    if (bareModel) models.add(bareModel);
  }

  return [...models];
}

/**
 * Accept either JSON arrays or newline/comma-separated form values from the UI.
 */
function rawModelValues(modelsInput?: unknown): string[] {
  if (Array.isArray(modelsInput))
    return modelsInput.filter((item): item is string => typeof item === "string");
  if (typeof modelsInput === "string") return modelsInput.split(/[\n,]/);
  return [];
}

/**
 * Store provider-scoped model lists as bare model ids even if a user pastes
 * provider@model into a form field.
 */
function bareProviderModel(model?: string): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) return "";
  return splitProviderModelSpec(trimmed)?.model || trimmed;
}

/**
 * Compare a raw JSON models field to the normalized list for migration.
 */
function sameStringArray(raw: unknown, normalized: string[]): boolean {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string"))
    return normalized.length === 0;
  return (
    raw.length === normalized.length && raw.every((value, index) => value === normalized[index])
  );
}

/**
 * Narrow unknown config data to the supported simple-provider formats.
 */
function isCustomProviderFormat(value: unknown): value is CustomProviderFormat {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

/**
 * Return a copy of a record without one key, avoiding delete for lint cleanliness.
 */
function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}
