export type FeishuDomain = "feishu" | "lark";
export type FeishuConfigStatus = "not_configured" | "configured";
export type FeishuSessionMode = "headless" | "terminal";

export interface FeishuHistoryConfig {
  persist: boolean;
  maxMessages: number;
  nativeResume: boolean;
}

export interface FeishuConfigDefaults {
  model: string;
  cwd: string;
}

export interface FeishuConfigFileInput {
  id?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  botOpenId?: string;
  domain?: string;
  model?: string;
  cwd?: string;
  sessionMode?: string;
  history?: Partial<FeishuHistoryConfig>;
}

export interface FeishuConfig {
  id: string;
  enabled: boolean;
  status: FeishuConfigStatus;
  appId?: string;
  appSecret?: string;
  botOpenId?: string;
  domain: FeishuDomain;
  model: string;
  cwd: string;
  sessionMode: FeishuSessionMode;
  history: FeishuHistoryConfig;
}

export function loadFeishuConfig(
  env: NodeJS.ProcessEnv,
  defaults: FeishuConfigDefaults,
  config: FeishuConfigFileInput = {}
): FeishuConfig {
  const id = normalizeAccountId(config.id);
  const appId = trimConfig(config.appId) || trimEnv(env.FEISHU_APP_ID);
  const appSecret = trimConfig(config.appSecret) || trimEnv(env.FEISHU_APP_SECRET);
  const botOpenId =
    trimConfig(config.botOpenId) ||
    trimEnv(env.CLAUDISH_FEISHU_BOT_OPEN_ID) ||
    trimEnv(env.FEISHU_BOT_OPEN_ID);
  const domain = normalizeDomain(trimConfig(config.domain) || env.FEISHU_DOMAIN);
  const model = trimConfig(config.model) || trimEnv(env.CLAUDISH_FEISHU_MODEL) || defaults.model;
  const cwd = trimConfig(config.cwd) || trimEnv(env.CLAUDISH_FEISHU_CWD) || defaults.cwd;
  const sessionMode = normalizeSessionMode(trimConfig(config.sessionMode));
  const history = normalizeHistoryConfig(config.history);
  const hasCredentials = Boolean(appId && appSecret);
  const enabled = config.enabled === false ? false : hasCredentials;

  return {
    id,
    enabled,
    status: enabled ? "configured" : "not_configured",
    appId: appId || undefined,
    appSecret: appSecret || undefined,
    botOpenId: botOpenId || undefined,
    domain,
    model,
    cwd,
    sessionMode,
    history,
  };
}

export function normalizeAccountId(value: string | undefined): string {
  const id = value?.trim() || "default";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`Invalid Feishu account id: ${id}`);
  }
  return id;
}

function normalizeDomain(value: string | undefined): FeishuDomain {
  return value?.trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

function normalizeSessionMode(value: string | undefined): FeishuSessionMode {
  return value?.trim().toLowerCase() === "terminal" ? "terminal" : "headless";
}

function normalizeHistoryConfig(
  value: Partial<FeishuHistoryConfig> | undefined
): FeishuHistoryConfig {
  const maxMessages = Number(value?.maxMessages);
  return {
    persist: value?.persist !== false,
    maxMessages: Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 50,
    nativeResume: value?.nativeResume !== false,
  };
}

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function trimConfig(value: string | undefined): string {
  return value?.trim() ?? "";
}
