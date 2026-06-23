import { getServiceLogPath } from "./paths.js";
import { findServicePort } from "./ports.js";
import { removeServiceState, writeServiceState, type ServiceState } from "./state.js";
import { startConfigWebServer, type ConfigWebServerOptions } from "../web-config-server.js";
import { ChannelManager } from "../channels/manager.js";
import { ensureWorkingDirectory, loadClaudishConfig, type ClaudishConfig } from "./config.js";

export interface ChannelStatusItem {
  id: string;
  status: string;
  activeSessions?: number;
  [key: string]: unknown;
}

export interface ChannelStatusSnapshot {
  channels: ChannelStatusItem[];
}

export interface ServiceChannelManager {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  getStatus(): ChannelStatusSnapshot;
}

export interface ServiceWebServer {
  port: number;
  stop(): void;
}

export interface StartServiceDaemonOptions {
  port?: number;
  cwd?: string;
  config?: ClaudishConfig;
  configPath?: string;
  now?: () => Date;
  startWebServer?: (options: ConfigWebServerOptions) => ServiceWebServer;
  createChannelManager?: (options: { cwd: string; config: ClaudishConfig }) => ServiceChannelManager;
}

export interface ServiceDaemonController {
  state: ServiceState;
  stop(): Promise<void>;
}

export async function startServiceDaemon(
  options: StartServiceDaemonOptions = {}
): Promise<ServiceDaemonController> {
  const config =
    options.config ??
    loadClaudishConfig({
      cwd: options.cwd,
      configPath: options.configPath,
    });
  const cwd = options.cwd ?? config.service.cwd;
  ensureWorkingDirectory(cwd);
  const preferredPort = options.port ?? config.service.port;
  const selectedPort = options.port ?? (await findServicePort(preferredPort)).port;
  const channelManager =
    options.createChannelManager?.({ cwd, config }) ?? new ChannelManager({ cwd, config });

  await channelManager.start();

  const webServer = (options.startWebServer ?? startConfigWebServer)({
    port: selectedPort,
    openBrowser: false,
    terminalWorkingDirectory: cwd,
    channelStatusProvider: () => channelManager.getStatus(),
  } as ConfigWebServerOptions) as ServiceWebServer;
  const state = buildDaemonState({
    cwd,
    port: webServer.port,
    now: options.now ?? (() => new Date()),
    channels: channelManager.getStatus(),
  });
  let stopped = false;

  writeServiceState(state);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await channelManager.stop();
    webServer.stop();
    removeServiceState();
  };

  process.once("SIGTERM", () => {
    stop().finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    stop().finally(() => process.exit(0));
  });

  return { state, stop };
}

function buildDaemonState(input: {
  cwd: string;
  port: number;
  now: () => Date;
  channels: ChannelStatusSnapshot;
}): ServiceState {
  const host = "127.0.0.1";

  return {
    pid: process.pid,
    startedAt: input.now().toISOString(),
    host,
    port: input.port,
    webUrl: `http://${host}:${input.port}/`,
    logPath: getServiceLogPath(),
    cwd: input.cwd,
    channels: Object.fromEntries(input.channels.channels.map((channel) => [channel.id, channel])),
  };
}
