import { FeishuChannel } from "./feishu/channel.js";
import { createFeishuSdkClients } from "./feishu/client.js";
import type { FeishuConfig } from "./feishu/config.js";
import type { Channel, ChannelStatusSnapshot } from "./types.js";
import { loadClaudishConfig, type ClaudishConfig } from "../service/config.js";

export interface ChannelManagerOptions {
  channels?: Channel[];
  cwd?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  config?: ClaudishConfig;
  configPath?: string;
  createFeishuChannel?: (config: FeishuConfig) => Channel;
}

export class ChannelManager {
  private readonly channels: Channel[];

  constructor(options: ChannelManagerOptions = {}) {
    this.channels = options.channels ?? createDefaultChannels(options);
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      await channel.start();
    }
  }

  async stop(): Promise<void> {
    for (const channel of this.channels) {
      await channel.stop();
    }
  }

  getStatus(): ChannelStatusSnapshot {
    return {
      channels: this.channels.map((channel) => channel.getStatus()),
    };
  }

  async restartChannel(id: string): Promise<boolean> {
    const channel = this.channels.find((item) => item.id === id);
    if (!channel) return false;

    await channel.stop();
    await channel.start();
    return true;
  }
}

function createDefaultChannels(options: ChannelManagerOptions): Channel[] {
  const cwd = options.cwd ?? process.cwd();
  const config =
    options.config?.channels.feishu ??
    loadClaudishConfig({
      cwd,
      model: options.model,
      env: options.env ?? process.env,
      configPath: options.configPath,
    }).channels.feishu;

  if (options.createFeishuChannel) {
    return [options.createFeishuChannel(config)];
  }

  return [
    new FeishuChannel({
      config,
      ...(config.enabled ? createFeishuSdkClients(config) : {}),
    }) as Channel,
  ];
}
