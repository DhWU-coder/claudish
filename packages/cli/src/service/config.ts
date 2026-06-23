import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadFeishuConfig, type FeishuConfig, type FeishuConfigFileInput } from "../channels/feishu/config.js";
import { getClaudishConfigPath, getDefaultWorkspacePath } from "./paths.js";
import { DEFAULT_SERVICE_PORT, resolvePreferredServicePort } from "./ports.js";

export interface ClaudishConfig {
  service: {
    port: number;
    cwd: string;
  };
  channels: {
    feishu: FeishuConfig;
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
  enabled?: unknown;
  appId?: unknown;
  appSecret?: unknown;
  botOpenId?: unknown;
  domain?: unknown;
  model?: unknown;
  cwd?: unknown;
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
  const feishuConfig = normalizeRawFeishuConfig(objectOrEmpty(rawConfig.channels?.feishu));
  if (!feishuConfig.cwd && configuredServiceCwd) {
    feishuConfig.cwd = serviceCwd;
  }

  return {
    service: {
      port: servicePort,
      cwd: serviceCwd,
    },
    channels: {
      feishu: loadFeishuConfig(
        env,
        {
          model: defaultModel,
          cwd: serviceCwd,
        },
        feishuConfig
      ),
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
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    appId: readString(raw.appId),
    appSecret: readString(raw.appSecret),
    botOpenId: readString(raw.botOpenId),
    domain: readString(raw.domain),
    model: readString(raw.model),
    cwd: expandHomePath(readString(raw.cwd)),
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

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}
