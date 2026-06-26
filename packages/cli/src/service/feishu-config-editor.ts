import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, parseDocument } from "yaml";
import { normalizeAccountId } from "../channels/feishu/config.js";
import { getClaudishConfigPath } from "./paths.js";

export interface FeishuAccountEditorState {
  id: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  hasAppSecret: boolean;
  botOpenId: string;
  domain: "feishu" | "lark";
  sendProgressReplies: boolean;
  model?: string;
  cwd?: string;
  sessionMode?: string;
}

export interface FeishuAccountsEditorState {
  accounts: FeishuAccountEditorState[];
}

export interface FeishuAccountSecretState {
  appSecret: string;
}

export interface SaveFeishuAccountsInput {
  accounts?: Array<Partial<FeishuAccountEditorState>>;
}

interface RawConfig {
  channels?: {
    feishu?: RawFeishuConfig;
  };
  [key: string]: unknown;
}

interface RawFeishuConfig {
  accounts?: RawFeishuAccount[];
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
  history?: unknown;
  [key: string]: unknown;
}

interface RawFeishuAccount extends RawFeishuConfig {
  id?: unknown;
}

const LEGACY_ACCOUNT_FIELDS = [
  "id",
  "enabled",
  "appId",
  "appSecret",
  "botOpenId",
  "domain",
  "model",
  "cwd",
  "sessionMode",
  "sendProgressReplies",
  "history",
];

export function getFeishuAccountsEditorState(
  configPath = getClaudishConfigPath()
): FeishuAccountsEditorState {
  const raw = readRawConfig(configPath);
  return {
    accounts: readRawFeishuAccounts(raw).map((account) => toPublicAccount(account)),
  };
}

export function getFeishuAccountSecret(
  accountId: string,
  configPath = getClaudishConfigPath()
): FeishuAccountSecretState | undefined {
  const id = normalizeAccountId(accountId);
  const account = readRawFeishuAccounts(readRawConfig(configPath)).find(
    (item) => readAccountId(item) === id
  );
  const appSecret = readString(account?.appSecret);
  return appSecret ? { appSecret } : undefined;
}

export function saveFeishuAccountsEditorState(
  input: SaveFeishuAccountsInput,
  configPath = getClaudishConfigPath()
): FeishuAccountsEditorState {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const raw = readRawConfig(configPath);
  const existingAccounts = readRawFeishuAccounts(raw);
  const existingById = new Map(
    existingAccounts.map((account) => [readAccountId(account), account])
  );
  const accounts = normalizeInputAccounts(input.accounts, existingById);
  const document = parseDocument(text || "{}");

  document.setIn(["channels", "feishu", "accounts"], accounts);
  for (const field of LEGACY_ACCOUNT_FIELDS) {
    document.deleteIn(["channels", "feishu", field]);
  }

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, document.toString(), "utf-8");
  return getFeishuAccountsEditorState(configPath);
}

function readRawConfig(configPath: string): RawConfig {
  if (!existsSync(configPath)) return {};
  const parsed = parse(readFileSync(configPath, "utf-8")) as unknown;
  return isRecord(parsed) ? (parsed as RawConfig) : {};
}

function readRawFeishuAccounts(raw: RawConfig): RawFeishuAccount[] {
  const feishu = raw.channels?.feishu;
  if (!isRecord(feishu)) return [];
  if (Array.isArray(feishu.accounts)) {
    return feishu.accounts.filter(isRecord) as RawFeishuAccount[];
  }
  if (hasLegacyFeishuAccount(feishu)) {
    return [{ ...feishu, id: readString(feishu.id) ?? "default" }];
  }
  return [];
}

function normalizeInputAccounts(
  accounts: SaveFeishuAccountsInput["accounts"],
  existingById: Map<string, RawFeishuAccount>
): RawFeishuAccount[] {
  if (!Array.isArray(accounts)) throw new Error("accounts must be an array");

  const seen = new Set<string>();
  return accounts.map((account) => {
    const id = normalizeAccountId(readString(account.id));
    if (seen.has(id)) throw new Error(`Duplicate Feishu account id: ${id}`);
    seen.add(id);

    const existing = existingById.get(id);
    const appId = readString(account.appId);
    if (!appId) throw new Error(`Feishu account ${id} requires appId`);
    const appSecret = readString(account.appSecret) || readString(existing?.appSecret);
    if (!appSecret) throw new Error(`Feishu account ${id} requires appSecret`);

    return cleanAccount({
      id,
      enabled: account.enabled !== false,
      appId,
      appSecret,
      botOpenId: readString(account.botOpenId),
      domain: readDomain(account.domain),
      sendProgressReplies: account.sendProgressReplies === true,
      model: readString(existing?.model),
      cwd: readString(existing?.cwd),
      sessionMode: readString(existing?.sessionMode),
      history: existing?.history,
    });
  });
}

function cleanAccount(account: RawFeishuAccount): RawFeishuAccount {
  return Object.fromEntries(
    Object.entries(account).filter(([, value]) => value !== undefined && value !== "")
  ) as RawFeishuAccount;
}

function toPublicAccount(account: RawFeishuAccount): FeishuAccountEditorState {
  const appSecret = readString(account.appSecret);
  const publicAccount: FeishuAccountEditorState = {
    id: readAccountId(account),
    enabled: account.enabled !== false,
    appId: readString(account.appId) ?? "",
    appSecret: "",
    hasAppSecret: Boolean(appSecret),
    botOpenId: readString(account.botOpenId) ?? "",
    domain: readDomain(account.domain),
    sendProgressReplies: account.sendProgressReplies === true,
  };
  const model = readString(account.model);
  const cwd = readString(account.cwd);
  const sessionMode = readString(account.sessionMode);
  if (model) publicAccount.model = model;
  if (cwd) publicAccount.cwd = cwd;
  if (sessionMode) publicAccount.sessionMode = sessionMode;
  return publicAccount;
}

function hasLegacyFeishuAccount(feishu: RawFeishuConfig): boolean {
  return Boolean(
    readString(feishu.appId) || readString(feishu.appSecret) || feishu.enabled !== undefined
  );
}

function readAccountId(account: RawFeishuAccount): string {
  return normalizeAccountId(readString(account.id));
}

function readDomain(value: unknown): "feishu" | "lark" {
  const domain = readString(value)?.toLowerCase() ?? "feishu";
  if (domain === "feishu" || domain === "lark") return domain;
  throw new Error(`Invalid Feishu domain: ${domain}`);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
