import { ensureWorkingDirectory, loadClaudishConfig } from "./config.js";
import { getServiceLogPath } from "./paths.js";
import { findServicePort } from "./ports.js";
import { spawnDetachedServiceDaemon } from "./process.js";
import {
  isProcessRunning,
  isStateRunning,
  readServiceState,
  removeServiceState,
  type ServiceState,
  writeServiceState,
} from "./state.js";

export interface StartServiceResult {
  state: ServiceState;
  warning?: string;
  alreadyRunning?: boolean;
}

export interface ServiceCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function formatStatus(state: ServiceState | null): string {
  if (!state) return "claudish service stopped";

  if (!isStateRunning(state)) {
    return `claudish service stopped (stale pid ${state.pid})`;
  }

  return [
    `claudish service running (pid ${state.pid})`,
    `Web UI: ${state.webUrl}`,
    `CWD: ${state.cwd}`,
    `Log: ${state.logPath}`,
  ].join("\n");
}

export function formatStartResult(result: StartServiceResult): string {
  const lines: string[] = [];
  if (result.warning) lines.push(result.warning);
  lines.push(
    result.alreadyRunning
      ? `claudish service already running (pid ${result.state.pid})`
      : `claudish service started (pid ${result.state.pid})`
  );
  lines.push(`Web UI: ${result.state.webUrl}`);
  lines.push(`Log: ${result.state.logPath}`);
  return lines.join("\n");
}

export async function startServiceCommand(
  options: ServiceCommandOptions = {}
): Promise<StartServiceResult> {
  const existing = readServiceState();
  if (isStateRunning(existing)) {
    return { state: existing as ServiceState, alreadyRunning: true };
  }

  const config = loadClaudishConfig({ cwd: options.cwd, env: options.env });
  const cwd = config.service.cwd;
  ensureWorkingDirectory(cwd);
  const logPath = getServiceLogPath();
  const portResult = await findServicePort(config.service.port);
  const host = "127.0.0.1";
  const pid = spawnDetachedServiceDaemon({
    cwd,
    port: portResult.port,
    logPath,
    env: options.env,
  });
  const state: ServiceState = {
    pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    host,
    port: portResult.port,
    webUrl: `http://${host}:${portResult.port}/`,
    logPath,
    cwd,
    channels: {},
  };

  writeServiceState(state);

  return {
    state,
    warning: portResult.warning,
  };
}

export async function stopServiceCommand(): Promise<string> {
  const state = readServiceState();
  if (!state) return "claudish service already stopped";

  if (isProcessRunning(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    await waitForProcessExit(state.pid, 3000);
  }

  removeServiceState();
  return `claudish service stopped (pid ${state.pid})`;
}

export async function restartServiceCommand(options: ServiceCommandOptions = {}): Promise<string> {
  await stopServiceCommand();
  return formatStartResult(await startServiceCommand(options));
}

export function statusServiceCommand(): string {
  return formatStatus(readServiceState());
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
