import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  type FeishuConfig,
  type FeishuConfigFileInput,
  loadFeishuConfig,
  normalizeAccountId,
} from "../channels/feishu/config.js";
import { getClaudishConfigPath, getDefaultWorkspacePath } from "./paths.js";
import { DEFAULT_SERVICE_PORT, resolvePreferredServicePort } from "./ports.js";

export interface ClaudishConfig {
  service: {
    port: number;
    cwd: string;
  };
  channels: {
    feishu: FeishuConfig;
    feishuAccounts: FeishuConfig[];
  };
}

export interface LoadClaudishConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  model?: string;
  configPath?: string;
}

interface RawClaudishConfig {
  service?: {
    port?: unknown;
    cwd?: unknown;
  };
  channels?: {
    feishu?: RawFeishuConfig;
  };
}

interface RawFeishuConfig {
  id?: unknown;
  enabled?: unknown;
  appId?: unknown;
  appSecret?: unknown;
  botOpenId?: unknown;
  domain?: unknown;
  model?: unknown;
  cwd?: unknown;
  sessionMode?: unknown;
  sendProgressReplies?: unknown;
  history?: {
    persist?: unknown;
    maxMessages?: unknown;
    nativeResume?: unknown;
  };
  accounts?: RawFeishuConfig[];
}

export function loadClaudishConfig(options: LoadClaudishConfigOptions = {}): ClaudishConfig {
  const env = options.env ?? process.env;
  const fallbackCwd = expandHomePath(options.cwd) ?? getDefaultWorkspacePath();
  const configPath = options.configPath ?? getClaudishConfigPath();
  const rawConfig = readRawClaudishConfig(configPath);
  const serviceSection = objectOrEmpty(rawConfig.service);
  const configuredServiceCwd = readString(serviceSection.cwd);
  const serviceCwd = expandHomePath(configuredServiceCwd) ?? fallbackCwd;
  const servicePort = readPort(serviceSection.port) ?? resolvePreferredServicePort(env);
  const defaultModel = options.model || trimEnv(env.CLAUDISH_MODEL) || "cx@gpt-5.5";
  const rawFeishuSection = objectOrEmpty(rawConfig.channels?.feishu);
  const feishuConfig = normalizeRawFeishuConfig(rawFeishuSection);
  if (!feishuConfig.cwd && configuredServiceCwd) {
    feishuConfig.cwd = serviceCwd;
  }
  const feishu = loadFeishuConfig(
    env,
    {
      model: defaultModel,
      cwd: serviceCwd,
    },
    feishuConfig
  );
  const feishuAccounts = loadFeishuAccounts({
    env,
    rawFeishu: rawFeishuSection,
    defaultModel,
    legacyFeishu: feishu,
  });

  return {
    service: {
      port: servicePort,
      cwd: serviceCwd,
    },
    channels: {
      feishu,
      feishuAccounts,
    },
  };
}

function readRawClaudishConfig(configPath: string): RawClaudishConfig {
  if (!existsSync(configPath)) return {};

  try {
    const parsed = parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RawClaudishConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read claudish config.yaml: ${message}`);
  }
}

export function ensureWorkingDirectory(cwd: string): void {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
}

function normalizeRawFeishuConfig(raw: RawFeishuConfig): FeishuConfigFileInput {
  return {
    id: readString(raw.id),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    appId: readString(raw.appId),
    appSecret: readString(raw.appSecret),
    botOpenId: readString(raw.botOpenId),
    domain: readString(raw.domain),
    model: readString(raw.model),
    cwd: expandHomePath(readString(raw.cwd)),
    sessionMode: readString(raw.sessionMode),
    sendProgressReplies:
      typeof raw.sendProgressReplies === "boolean" ? raw.sendProgressReplies : undefined,
    history: normalizeRawFeishuHistory(raw.history),
  };
}

function loadFeishuAccounts(input: {
  env: NodeJS.ProcessEnv;
  rawFeishu: RawFeishuConfig;
  defaultModel: string;
  legacyFeishu: FeishuConfig;
}): FeishuConfig[] {
  if (!Array.isArray(input.rawFeishu.accounts)) return [input.legacyFeishu];

  const seenIds = new Set<string>();
  return input.rawFeishu.accounts.map((rawAccount) => {
    const account = normalizeRawFeishuConfig(objectOrEmpty(rawAccount));
    const id = normalizeAccountId(account.id);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate Feishu account id: ${id}`);
    }
    seenIds.add(id);
    return loadFeishuConfig(
      input.env,
      {
        model: input.defaultModel,
        cwd: account.cwd ?? join(getDefaultWorkspacePath(), id),
      },
      {
        ...account,
        id,
      }
    );
  });
}

function normalizeRawFeishuHistory(raw: RawFeishuConfig["history"]) {
  const history = objectOrEmpty(raw);
  return {
    persist: typeof history.persist === "boolean" ? history.persist : undefined,
    maxMessages: readPositiveInteger(history.maxMessages),
    nativeResume: typeof history.nativeResume === "boolean" ? history.nativeResume : undefined,
  };
}

function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function objectOrEmpty<T extends object>(value: T | undefined): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as T;
  return value;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPort(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const port = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return DEFAULT_SERVICE_PORT;
  return port;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}
