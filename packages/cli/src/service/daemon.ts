import { mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { ChannelManager } from "../channels/manager.js";
import { type ConfigWebServerOptions, startConfigWebServer } from "../web-config-server.js";
import { type ClaudishConfig, ensureWorkingDirectory, loadClaudishConfig } from "./config.js";
import { getClaudishConfigPath, getServiceLogPath } from "./paths.js";
import { findServicePort } from "./ports.js";
import { type ServiceState, removeServiceState, writeServiceState } from "./state.js";

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
  reloadConfig?(config: ClaudishConfig): Promise<unknown> | unknown;
  getStatus(): ChannelStatusSnapshot;
}

export interface ServiceWebServer {
  port: number;
  stop(): void;
}

export interface ServiceConfigWatcher {
  close(): void;
}

export interface ServiceConfigWatcherOptions {
  configPath: string;
  onChange(): Promise<void> | void;
}

export interface StartServiceDaemonOptions {
  port?: number;
  cwd?: string;
  config?: ClaudishConfig;
  configPath?: string;
  now?: () => Date;
  startWebServer?: (options: ConfigWebServerOptions) => ServiceWebServer;
  createChannelManager?: (options: {
    cwd: string;
    config: ClaudishConfig;
  }) => ServiceChannelManager;
  createConfigWatcher?: (options: ServiceConfigWatcherOptions) => ServiceConfigWatcher;
}

export interface ServiceDaemonController {
  state: ServiceState;
  stop(): Promise<void>;
}

export async function startServiceDaemon(
  options: StartServiceDaemonOptions = {}
): Promise<ServiceDaemonController> {
  const configPath = options.configPath ?? getClaudishConfigPath();
  const config =
    options.config ??
    loadClaudishConfig({
      cwd: options.cwd,
      configPath,
    });
  const cwd = options.cwd ?? config.service.cwd;
  ensureWorkingDirectory(cwd);
  const preferredPort = options.port ?? config.service.port;
  const selectedPort = options.port ?? (await findServicePort(preferredPort)).port;
  const channelManager =
    options.createChannelManager?.({ cwd, config }) ?? new ChannelManager({ cwd, config });

  await channelManager.start();

  const configWatcher =
    !options.config && channelManager.reloadConfig
      ? (options.createConfigWatcher ?? watchClaudishConfig)({
          configPath,
          onChange: async () => {
            try {
              const nextConfig = loadClaudishConfig({
                cwd,
                configPath,
              });
              await channelManager.reloadConfig?.(nextConfig);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[claudish] Failed to hot reload config.yaml: ${message}`);
            }
          },
        })
      : undefined;

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
    configWatcher?.close();
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

function watchClaudishConfig(options: ServiceConfigWatcherOptions): ServiceConfigWatcher {
  const directory = dirname(options.configPath);
  const fileName = basename(options.configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(directory, (_eventType, changedFileName) => {
    if (changedFileName && String(changedFileName) !== fileName) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      Promise.resolve(options.onChange()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[claudish] Failed to hot reload config.yaml: ${message}`);
      });
    }, 500);
  });

  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
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
