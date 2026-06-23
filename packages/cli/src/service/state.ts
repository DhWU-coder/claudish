import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getServiceStatePath } from "./paths.js";

export interface ServiceState {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  webUrl: string;
  logPath: string;
  cwd: string;
  channels: Record<string, unknown>;
}

export function readServiceState(path = getServiceStatePath()): ServiceState | null {
  if (!existsSync(path)) return null;

  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as Partial<ServiceState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.startedAt !== "string" ||
      typeof state.host !== "string" ||
      typeof state.port !== "number" ||
      typeof state.webUrl !== "string" ||
      typeof state.logPath !== "string" ||
      typeof state.cwd !== "string" ||
      !state.channels ||
      typeof state.channels !== "object"
    ) {
      return null;
    }

    return state as ServiceState;
  } catch {
    return null;
  }
}

export function writeServiceState(state: ServiceState, path = getServiceStatePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function removeServiceState(path = getServiceStatePath()): void {
  rmSync(path, { force: true });
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isStateRunning(state: ServiceState | null): boolean {
  return state ? isProcessRunning(state.pid) : false;
}
