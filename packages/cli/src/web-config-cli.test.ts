import { describe, expect, test } from "bun:test";
import { startConfigWebCli } from "./web-config-cli.js";

describe("web config CLI launcher", () => {
  test("starts the Web UI with browser opening enabled by default", () => {
    let openedUrl = "";
    const server = startConfigWebCli({
      browserOpener: (url) => {
        // Tests capture the requested URL instead of opening a real browser.
        openedUrl = url;
      },
    });

    try {
      expect(openedUrl).toBe(`http://127.0.0.1:${server.port}/`);
    } finally {
      server.stop(true);
    }
  });
});
