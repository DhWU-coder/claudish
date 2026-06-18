import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteCustomProvider,
  getConfigEditorState,
  saveBuiltinProviderModels,
  saveGeneralDefaults,
  saveSimpleCustomProvider,
} from "./config-editor.js";
import { loadConfig, saveConfig } from "./profile-config.js";

const originalClaudishHome = process.env.CLAUDISH_HOME;
const originalDefaultProvider = process.env.CLAUDISH_DEFAULT_PROVIDER;
const originalModel = process.env.CLAUDISH_MODEL;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiCodexApiKey = process.env.OPENAI_CODEX_API_KEY;
let tempHome: string | undefined;

beforeEach(() => {
  // Each test gets an isolated config home so persisted edits are real but contained.
  tempHome = mkdtempSync(join(tmpdir(), "claudish-config-editor-"));
  process.env.CLAUDISH_HOME = join(tempHome, ".claudish");
  process.env.CLAUDISH_DEFAULT_PROVIDER = undefined;
  process.env.CLAUDISH_MODEL = undefined;
  process.env.OPENAI_API_KEY = undefined;
  process.env.OPENAI_CODEX_API_KEY = undefined;
});

afterEach(() => {
  // Restore process environment because config resolution reads env vars directly.
  if (originalClaudishHome === undefined) process.env.CLAUDISH_HOME = undefined;
  else process.env.CLAUDISH_HOME = originalClaudishHome;

  if (originalDefaultProvider === undefined) process.env.CLAUDISH_DEFAULT_PROVIDER = undefined;
  else process.env.CLAUDISH_DEFAULT_PROVIDER = originalDefaultProvider;

  if (originalModel === undefined) process.env.CLAUDISH_MODEL = undefined;
  else process.env.CLAUDISH_MODEL = originalModel;

  if (originalOpenAiApiKey === undefined) process.env.OPENAI_API_KEY = undefined;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;

  if (originalOpenAiCodexApiKey === undefined) process.env.OPENAI_CODEX_API_KEY = undefined;
  else process.env.OPENAI_CODEX_API_KEY = originalOpenAiCodexApiKey;

  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("config editor", () => {
  test("saveGeneralDefaults trims and persists default model and provider", () => {
    saveGeneralDefaults({
      defaultModel: " gpt-5.5 ",
      defaultProvider: " openrouter ",
    });

    const config = loadConfig();
    expect(config.defaultModel).toBe("gpt-5.5");
    expect(config.defaultProvider).toBe("openrouter");
  });

  test("getConfigEditorState includes configured builtin OAuth providers", () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    const state = getConfigEditorState();
    const codex = state.customProviders.find((provider) => provider.id === "cx");

    // Builtin providers only appear in the editable table after local auth is configured.
    expect(codex).toMatchObject({
      id: "cx",
      source: "builtin",
      credentialSource: "oauth-file",
      authMode: "oauth",
      typeLabel: "Codex-Oauth",
      authFile: oauthPath,
      defaultModel: "gpt-5.5",
    });
    expect(codex?.baseUrl).toBeUndefined();
    expect(codex?.models).toContain("gpt-5.5");
    expect(codex?.models).toContain("gpt-5-codex");
  });

  test("saveBuiltinProviderModels persists OAuth provider models without custom endpoint overrides", () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    saveBuiltinProviderModels({
      providerId: "cx",
      defaultModel: "gpt-5-codex",
      models: ["gpt-5-codex", "gpt-5.5"],
    });

    const config = loadConfig();
    const codex = getConfigEditorState().customProviders.find((provider) => provider.id === "cx");

    // Builtin OAuth provider model editing is metadata only; it must not turn
    // cx into a plain custom OpenAI endpoint.
    expect(config.customEndpoints?.cx).toBeUndefined();
    expect(config.builtinProviderModels?.cx).toEqual(["gpt-5-codex", "gpt-5.5"]);
    expect(codex?.defaultModel).toBe("gpt-5-codex");
    expect(codex?.models).toEqual(["gpt-5-codex", "gpt-5.5"]);
  });

  test("saveBuiltinProviderModels can refresh an API-key builtin without custom endpoint overrides", () => {
    saveConfig({
      ...loadConfig(),
      apiKeys: { OPENROUTER_API_KEY: "old-key" },
    });

    saveBuiltinProviderModels({
      providerId: "or",
      apiKey: "new-key",
      defaultModel: "openai/gpt-5",
      models: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
    });

    const config = loadConfig();
    const openrouter = getConfigEditorState().customProviders.find(
      (provider) => provider.id === "or"
    );

    // Builtin API-key providers keep their builtin transport while allowing
    // the UI to refresh the stored local credential and model list.
    expect(config.customEndpoints?.or).toBeUndefined();
    expect(config.apiKeys?.OPENROUTER_API_KEY).toBe("new-key");
    expect(config.builtinProviderModels?.or).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4"]);
    expect(openrouter?.apiKey).toBe("new-key");
  });

  test("deleteCustomProvider clears builtin OAuth credentials without disabling the provider", () => {
    const oauthPath = join(process.env.CLAUDISH_HOME!, "codex-oauth.json");
    mkdirSync(process.env.CLAUDISH_HOME!, { recursive: true });
    saveConfig({ ...loadConfig(), defaultProvider: "openai-codex" });
    writeFileSync(
      oauthPath,
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
      })
    );

    expect(deleteCustomProvider("cx")).toBe(true);

    // Removing a builtin provider means clearing its local auth cache; the row
    // disappears because it is no longer configured.
    expect(existsSync(oauthPath)).toBe(false);
    expect(loadConfig().defaultProvider).toBeUndefined();
    expect(getConfigEditorState().customProviders.some((provider) => provider.id === "cx")).toBe(
      false
    );
  });

  test("deleteCustomProvider refuses to clear builtin credentials that only come from env", () => {
    process.env.OPENAI_CODEX_API_KEY = "sk-env";

    expect(() => deleteCustomProvider("cx")).toThrow(
      "Provider 'cx' is configured by environment variable OPENAI_CODEX_API_KEY"
    );
  });

  test("saveGeneralDefaults splits provider model specs before persisting", () => {
    // A selected provider@model option should fill the two config fields, not
    // store the combined routing spec as the bare default model.
    saveGeneralDefaults({
      defaultModel: " cx@gpt-5.5 ",
      defaultProvider: " openrouter ",
    });

    const config = loadConfig();
    expect(config.defaultProvider).toBe("cx");
    expect(config.defaultModel).toBe("gpt-5.5");
  });

  test("saveGeneralDefaults removes empty default model and provider", () => {
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultModel: "cx@gpt-5.5",
      defaultProvider: "openrouter",
    });

    saveGeneralDefaults({ defaultModel: "", defaultProvider: "" });

    const config = loadConfig();
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultProvider).toBeUndefined();
  });

  test("saveSimpleCustomProvider normalizes id and url before persisting", () => {
    saveSimpleCustomProvider({
      providerId: " Corp_OpenAI ",
      format: "openai",
      baseUrl: "https://llm.example.com/v1/",
      apiKey: "${CORP_OPENAI_KEY}",
      defaultModel: " gpt-4o ",
      models: [" gpt-4o ", "gpt-4.1", "", "gpt-4o"],
    });

    expect(loadConfig().customEndpoints?.corp_openai).toEqual({
      kind: "simple",
      url: "https://llm.example.com/v1",
      format: "openai",
      apiKey: "${CORP_OPENAI_KEY}",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4.1"],
    });
  });

  test("saveSimpleCustomProvider migrates the default model into models", () => {
    saveSimpleCustomProvider({
      providerId: "corp-openai",
      format: "openai",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "secret",
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o"],
    });

    expect(loadConfig().customEndpoints?.["corp-openai"]).toMatchObject({
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o"],
    });
  });

  test("saveSimpleCustomProvider keeps an existing api key when editing with an empty key", () => {
    // Provider edits from the Web UI should not erase a saved secret when the
    // masked key field is left blank.
    saveSimpleCustomProvider({
      providerId: "corp-openai",
      format: "openai",
      baseUrl: "https://old.example.com/v1",
      apiKey: "sk-existing",
      defaultModel: "gpt-4o",
    });

    saveSimpleCustomProvider({
      providerId: "corp-openai",
      format: "anthropic",
      baseUrl: "https://new.example.com/v1",
      apiKey: "",
      defaultModel: "claude-opus-4-7",
    });

    expect(loadConfig().customEndpoints?.["corp-openai"]).toEqual({
      kind: "simple",
      url: "https://new.example.com/v1",
      format: "anthropic",
      apiKey: "sk-existing",
      defaultModel: "claude-opus-4-7",
      models: ["claude-opus-4-7"],
    });
  });

  test("getConfigEditorState directly migrates legacy provider models", () => {
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "corp-openai": {
          kind: "simple",
          url: "https://llm.example.com/v1",
          format: "openai",
          apiKey: "secret",
          defaultModel: "gpt-4o",
        },
      },
    });

    const state = getConfigEditorState();

    expect(state.customProviders[0]?.models).toEqual(["gpt-4o"]);
    expect(loadConfig().customEndpoints?.["corp-openai"]).toMatchObject({
      defaultModel: "gpt-4o",
      models: ["gpt-4o"],
    });
  });

  test("deleteCustomProvider removes a provider and clears matching default provider", () => {
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultProvider: "corp-openai",
      customEndpoints: {
        "corp-openai": {
          kind: "simple",
          url: "https://llm.example.com/v1",
          format: "openai",
          apiKey: "secret",
          defaultModel: "gpt-4o",
        },
      },
    });

    expect(deleteCustomProvider("corp-openai")).toBe(true);

    const config = loadConfig();
    expect(config.customEndpoints?.["corp-openai"]).toBeUndefined();
    expect(config.defaultProvider).toBeUndefined();
  });

  test("getConfigEditorState exposes effective values and their sources", () => {
    process.env.CLAUDISH_DEFAULT_PROVIDER = "litellm";
    process.env.CLAUDISH_MODEL = "g@gemini-3-pro-preview";
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultModel: "cx@gpt-5.5",
      defaultProvider: "openrouter",
      customEndpoints: {
        "corp-openai": {
          kind: "simple",
          url: "https://llm.example.com/v1",
          format: "openai",
          apiKey: "secret",
          defaultModel: "gpt-4o",
          models: ["gpt-4o", "gpt-4.1"],
        },
      },
    });

    const state = getConfigEditorState();

    expect(state.configDefaults.defaultModel).toBe("gpt-5.5");
    expect(state.configDefaults.defaultProvider).toBe("cx");
    expect(state.effectiveDefaultModel).toEqual({
      value: "gemini-3-pro-preview",
      source: "env-var",
    });
    expect(state.effectiveDefaultProvider).toEqual({
      value: "g",
      source: "env-var",
    });
    expect(state.customProviders).toHaveLength(1);
    expect(state.customProviders[0]?.id).toBe("corp-openai");
    expect(state.customProviders[0]?.models).toEqual(["gpt-4o", "gpt-4.1"]);
  });

  test("getConfigEditorState groups bare model options by provider", () => {
    // The Web UI renders provider and model as separate inputs, so scoped
    // suggestions must not include provider@model display strings.
    saveConfig({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      defaultModel: "gpt-5.5",
      defaultProvider: "cx",
      customEndpoints: {
        "corp-openai": {
          kind: "simple",
          url: "https://llm.example.com/v1",
          format: "openai",
          apiKey: "secret",
          defaultModel: "gpt-4o",
          models: ["gpt-4o", "gpt-4.1"],
        },
      },
    });

    const state = getConfigEditorState();

    expect(state.modelOptionsByProvider.cx).toContain("gpt-5.5");
    expect(state.modelOptionsByProvider.cx).toContain("gpt-5-codex");
    expect(state.modelOptionsByProvider["corp-openai"]).toEqual(["gpt-4o", "gpt-4.1"]);
    expect(state.modelOptionsByProvider.cx).not.toContain("cx@gpt-5.5");
  });
});
