/**
 * CLI launcher for the local Web configuration UI.
 */

import { type ConfigWebServerOptions, startConfigWebServer } from "./web-config-server.js";

/**
 * Start the Web UI from CLI commands and open the browser by default.
 */
export function startConfigWebCli(
  options: ConfigWebServerOptions = {}
): ReturnType<typeof startConfigWebServer> {
  return startConfigWebServer({
    ...options,
    openBrowser: options.openBrowser ?? true,
  });
}
