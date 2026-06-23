import { homedir } from "node:os";
import { join } from "node:path";

export function resolveClaudishHome(): string {
  return process.env.CLAUDISH_HOME || join(homedir(), ".claudish");
}

export function getServiceStatePath(): string {
  return join(resolveClaudishHome(), "service.json");
}

export function getServiceLogPath(): string {
  return join(resolveClaudishHome(), "logs", "service.log");
}

export function getClaudishConfigPath(): string {
  return join(resolveClaudishHome(), "config.yaml");
}

export function getDefaultWorkspacePath(): string {
  return join(resolveClaudishHome(), "workspace");
}
