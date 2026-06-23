/**
 * CLI launcher for the local Web configuration UI.
 */

import { type ConfigWebServerOptions, startConfigWebServer } from "./web-config-server.js";
import {
  isStateRunning,
  readServiceState,
  type ServiceState,
} from "./service/state.js";

export interface ConfigWebCliOptions extends ConfigWebServerOptions {
  serviceState?: ServiceState | null;
  messageWriter?: (message: string) => void;
}

/**
 * Start the Web UI from CLI commands and open the browser by default.
 */
export function startConfigWebCli(
  options: ConfigWebCliOptions = {}
): ReturnType<typeof startConfigWebServer> | null {
  const serviceState =
    Object.hasOwn(options, "serviceState") ? options.serviceState : readServiceState();
  const writeMessage = options.messageWriter ?? console.log;

  if (!isStateRunning(serviceState ?? null)) {
    writeMessage("claudish service is not running. Run: claudish start");
    return null;
  }

  if (options.openBrowser ?? true) {
    (options.browserOpener ?? openUrlInBrowser)(serviceState!.webUrl);
  }
  writeMessage(`Claudish Web UI: ${serviceState!.webUrl}`);
  return null;
}

function openUrlInBrowser(url: string): void {
  Bun.spawn({
    cmd: browserOpenCommand(url),
    stdout: "ignore",
    stderr: "ignore",
  });
}

function browserOpenCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}
