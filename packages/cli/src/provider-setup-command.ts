import { confirm, input, password, select } from "@inquirer/prompts";
import { loadConfig, saveConfig } from "./profile-config.js";
import { getProviderByName } from "./providers/provider-definitions.js";

export type ProviderCompatibility = "openai" | "anthropic" | "gemini";

export interface ProviderSetupInput {
  providerId: string;
  compatibility: ProviderCompatibility;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function validateProviderId(providerId: string): true | string {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return "provider-id is required";
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
    return "Use lowercase letters, numbers, '-' or '_', and start with a letter";
  }
  if (getProviderByName(normalized)) {
    return `Provider '${normalized}' is already built in; choose another provider-id`;
  }
  return true;
}

export function validateUrl(value: string): true | string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "base_url must start with http:// or https://";
    }
    return true;
  } catch {
    return "Enter a valid base_url, for example https://api.example.com/v1";
  }
}

export function saveProviderConfig(input: ProviderSetupInput): void {
  const providerId = normalizeProviderId(input.providerId);
  const config = loadConfig();
  config.customEndpoints = {
    ...(config.customEndpoints ?? {}),
    [providerId]: {
      kind: "simple",
      url: input.baseUrl.trim().replace(/\/+$/, ""),
      format: input.compatibility,
      apiKey: input.apiKey.trim(),
      defaultModel: input.modelId.trim(),
    },
  };
  saveConfig(config);
}

export async function setProviderCommand(): Promise<void> {
  const providerId = normalizeProviderId(
    await input({
      message: "provider-id:",
      validate: validateProviderId,
    })
  );

  const config = loadConfig();
  if (config.customEndpoints?.[providerId]) {
    const overwrite = await confirm({
      message: `Provider '${providerId}' already exists. Overwrite it?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      process.exit(0);
    }
  }

  const compatibility = await select<ProviderCompatibility>({
    message: "provider compatible type:",
    choices: [
      { name: "openai", value: "openai" },
      { name: "anthropic", value: "anthropic" },
      { name: "gemini", value: "gemini" },
    ],
  });

  const baseUrl = await input({
    message:
      compatibility === "openai"
        ? "base_url (for example https://api.example.com/v1):"
        : "base_url:",
    validate: validateUrl,
  });

  const apiKey = await password({
    message: "api-key:",
    mask: "*",
    validate: (value) => (value.trim() ? true : "api-key is required"),
  });

  const modelId = await input({
    message: "model-id (default model for this provider):",
    validate: (value) => (value.trim() ? true : "model-id is required"),
  });

  saveProviderConfig({
    providerId,
    compatibility,
    baseUrl,
    apiKey,
    modelId,
  });

  console.log(`Provider '${providerId}' saved to ~/.claudish/config.json`);
  console.log(`Default model: claudish --model ${providerId} "task"`);
  console.log(`Override model: claudish --model ${providerId}@<model-id> "task"`);
  process.exit(0);
}
