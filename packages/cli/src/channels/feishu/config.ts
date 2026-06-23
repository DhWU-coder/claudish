export type FeishuDomain = "feishu" | "lark";
export type FeishuConfigStatus = "not_configured" | "configured";

export interface FeishuConfigDefaults {
  model: string;
  cwd: string;
}

export interface FeishuConfigFileInput {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  botOpenId?: string;
  domain?: string;
  model?: string;
  cwd?: string;
}

export interface FeishuConfig {
  enabled: boolean;
  status: FeishuConfigStatus;
  appId?: string;
  appSecret?: string;
  botOpenId?: string;
  domain: FeishuDomain;
  model: string;
  cwd: string;
}

export function loadFeishuConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: FeishuConfigDefaults,
  config: FeishuConfigFileInput = {}
): FeishuConfig {
  const appId = trimConfig(config.appId) || trimEnv(env.FEISHU_APP_ID);
  const appSecret = trimConfig(config.appSecret) || trimEnv(env.FEISHU_APP_SECRET);
  const botOpenId =
    trimConfig(config.botOpenId) ||
    trimEnv(env.CLAUDISH_FEISHU_BOT_OPEN_ID) ||
    trimEnv(env.FEISHU_BOT_OPEN_ID);
  const domain = normalizeDomain(trimConfig(config.domain) || env.FEISHU_DOMAIN);
  const model = trimConfig(config.model) || trimEnv(env.CLAUDISH_FEISHU_MODEL) || defaults.model;
  const cwd = trimConfig(config.cwd) || trimEnv(env.CLAUDISH_FEISHU_CWD) || defaults.cwd;
  const hasCredentials = Boolean(appId && appSecret);
  const enabled = config.enabled === false ? false : hasCredentials;

  return {
    enabled,
    status: enabled ? "configured" : "not_configured",
    appId: appId || undefined,
    appSecret: appSecret || undefined,
    botOpenId: botOpenId || undefined,
    domain,
    model,
    cwd,
  };
}

function normalizeDomain(value: string | undefined): FeishuDomain {
  return value?.trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function trimConfig(value: string | undefined): string {
  return value?.trim() ?? "";
}
