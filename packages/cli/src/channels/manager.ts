import { join } from "node:path";
import { type ClaudishConfig, loadClaudishConfig } from "../service/config.js";
import { resolveClaudishHome } from "../service/paths.js";
import { FeishuChannel } from "./feishu/channel.js";
import { createFeishuSdkClients } from "./feishu/client.js";
import type { FeishuConfig } from "./feishu/config.js";
import type { Channel, ChannelStatusSnapshot } from "./types.js";

export interface ChannelManagerOptions {
  channels?: Channel[];
  cwd?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  config?: ClaudishConfig;
  configPath?: string;
  createFeishuChannel?: (config: FeishuConfig) => Channel;
}

export interface ChannelReloadResult {
  added: string[];
  removed: string[];
  restarted: string[];
  updated: string[];
  unchanged: string[];
  ignoredRestartFields: string[];
}

export class ChannelManager {
  private readonly channels = new Map<string, Channel>();
  private readonly feishuConfigs = new Map<string, FeishuConfig>();
  private readonly createFeishuChannel: (config: FeishuConfig) => Channel;
  private started = false;

  constructor(options: ChannelManagerOptions = {}) {
    this.createFeishuChannel = options.createFeishuChannel ?? createFeishuChannel;

    if (options.channels) {
      for (const channel of options.channels) {
        this.channels.set(channel.id, channel);
      }
      return;
    }

    const config = resolveManagerConfig(options);
    for (const account of resolveFeishuAccounts(config)) {
      const channel = this.createFeishuChannel(account);
      this.channels.set(channel.id, channel);
      this.feishuConfigs.set(channel.id, account);
    }
  }

  async start(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.start();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    this.started = false;
  }

  getStatus(): ChannelStatusSnapshot {
    return {
      channels: Array.from(this.channels.values()).map((channel) => channel.getStatus()),
    };
  }

  async restartChannel(id: string): Promise<boolean> {
    const channel = this.channels.get(id);
    if (!channel) return false;

    await channel.stop();
    await channel.start();
    return true;
  }

  async reloadConfig(config: ClaudishConfig): Promise<ChannelReloadResult> {
    const result = createEmptyReloadResult();
    const nextConfigs = new Map<string, FeishuConfig>();
    const nextChannelIds: string[] = [];

    for (const account of resolveFeishuAccounts(config)) {
      const channelId = resolveFeishuChannelId(account);
      nextConfigs.set(channelId, account);
      nextChannelIds.push(channelId);
    }

    await this.removeDeletedFeishuChannels(nextConfigs, result);

    for (const channelId of nextChannelIds) {
      const nextConfig = nextConfigs.get(channelId);
      if (!nextConfig) continue;
      await this.reloadFeishuChannel(channelId, nextConfig, result);
    }

    result.ignoredRestartFields = Array.from(new Set(result.ignoredRestartFields));
    return result;
  }

  private async removeDeletedFeishuChannels(
    nextConfigs: Map<string, FeishuConfig>,
    result: ChannelReloadResult
  ): Promise<void> {
    for (const channelId of Array.from(this.feishuConfigs.keys())) {
      if (nextConfigs.has(channelId)) continue;
      await this.removeFeishuChannel(channelId);
      result.removed.push(channelId);
    }
  }

  private async reloadFeishuChannel(
    channelId: string,
    nextConfig: FeishuConfig,
    result: ChannelReloadResult
  ): Promise<void> {
    const previousConfig = this.feishuConfigs.get(channelId);
    if (!previousConfig) {
      await this.addFeishuChannel(nextConfig, result);
      return;
    }

    const ignoredFields = collectIgnoredRestartFields(previousConfig, nextConfig);
    result.ignoredRestartFields.push(...ignoredFields.map((field) => `${channelId}.${field}`));
    const effectiveConfig = preserveNonHotFeishuConfig(previousConfig, nextConfig);
    if (requiresFeishuChannelRestart(previousConfig, effectiveConfig)) {
      await this.replaceFeishuChannel(channelId, effectiveConfig, result);
      return;
    }

    if (hasFeishuRuntimeSwitchChanges(previousConfig, effectiveConfig)) {
      await this.updateFeishuChannel(channelId, effectiveConfig, result);
      return;
    }

    this.feishuConfigs.set(channelId, effectiveConfig);
    result.unchanged.push(channelId);
  }

  private async addFeishuChannel(config: FeishuConfig, result: ChannelReloadResult): Promise<void> {
    const channel = this.createFeishuChannel(config);
    this.channels.set(channel.id, channel);
    this.feishuConfigs.set(channel.id, config);
    if (this.started) await channel.start();
    result.added.push(channel.id);
  }

  private async removeFeishuChannel(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (channel) {
      await channel.stop();
      this.channels.delete(channelId);
    }
    this.feishuConfigs.delete(channelId);
  }

  private async replaceFeishuChannel(
    channelId: string,
    config: FeishuConfig,
    result: ChannelReloadResult
  ): Promise<void> {
    const channel = this.channels.get(channelId);
    if (channel) {
      await channel.stop();
    }
    const nextChannel = this.createFeishuChannel(config);
    this.channels.set(nextChannel.id, nextChannel);
    this.feishuConfigs.set(nextChannel.id, config);
    if (this.started) await nextChannel.start();
    result.restarted.push(nextChannel.id);
  }

  private async updateFeishuChannel(
    channelId: string,
    config: FeishuConfig,
    result: ChannelReloadResult
  ): Promise<void> {
    const channel = this.channels.get(channelId);
    await channel?.updateConfig?.(config);
    this.feishuConfigs.set(channelId, config);
    result.updated.push(channelId);
  }
}

function resolveManagerConfig(options: ChannelManagerOptions): ClaudishConfig {
  const cwd = options.cwd ?? process.cwd();
  return (
    options.config ??
    loadClaudishConfig({
      cwd,
      model: options.model,
      env: options.env ?? process.env,
      configPath: options.configPath,
    })
  );
}

function createFeishuChannel(config: FeishuConfig): Channel {
  return new FeishuChannel({
    config,
    historyBaseDir: resolveFeishuHistoryBaseDir(config),
    ...(config.enabled ? createFeishuSdkClients(config) : {}),
  }) as Channel;
}

function resolveFeishuHistoryBaseDir(config: FeishuConfig): string | undefined {
  if (config.id === "default") return undefined;
  // 多账号模式下按账号隔离历史，避免不同飞书应用里的同名群聊互相串会话。
  return join(resolveClaudishHome(), "channels", "feishu", config.id, "sessions");
}

function resolveFeishuAccounts(config: ClaudishConfig): FeishuConfig[] {
  return config.channels.feishuAccounts ?? [config.channels.feishu];
}

function createEmptyReloadResult(): ChannelReloadResult {
  return {
    added: [],
    removed: [],
    restarted: [],
    updated: [],
    unchanged: [],
    ignoredRestartFields: [],
  };
}

function resolveFeishuChannelId(config: FeishuConfig): string {
  return config.id && config.id !== "default" ? `feishu:${config.id}` : "feishu";
}

function preserveNonHotFeishuConfig(
  previousConfig: FeishuConfig,
  nextConfig: FeishuConfig
): FeishuConfig {
  return {
    ...nextConfig,
    cwd: previousConfig.cwd,
    model: previousConfig.model,
    sessionMode: previousConfig.sessionMode,
    history: previousConfig.history,
  };
}

function requiresFeishuChannelRestart(
  previousConfig: FeishuConfig,
  nextConfig: FeishuConfig
): boolean {
  return (
    previousConfig.enabled !== nextConfig.enabled ||
    previousConfig.appId !== nextConfig.appId ||
    previousConfig.appSecret !== nextConfig.appSecret ||
    previousConfig.botOpenId !== nextConfig.botOpenId ||
    previousConfig.domain !== nextConfig.domain
  );
}

function hasFeishuRuntimeSwitchChanges(
  previousConfig: FeishuConfig,
  nextConfig: FeishuConfig
): boolean {
  return previousConfig.sendProgressReplies !== nextConfig.sendProgressReplies;
}

function collectIgnoredRestartFields(
  previousConfig: FeishuConfig,
  nextConfig: FeishuConfig
): string[] {
  const fields: string[] = [];
  if (previousConfig.cwd !== nextConfig.cwd) fields.push("cwd");
  if (previousConfig.model !== nextConfig.model) fields.push("model");
  if (previousConfig.sessionMode !== nextConfig.sessionMode) fields.push("sessionMode");
  if (JSON.stringify(previousConfig.history) !== JSON.stringify(nextConfig.history)) {
    fields.push("history");
  }
  return fields;
}
