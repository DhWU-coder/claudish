import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { findServicePort, resolvePreferredServicePort } from "./ports.js";

function listenOnLocalhost(port: number) {
  const server = createServer();

  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe("service ports", () => {
  test("uses env port when valid", () => {
    expect(resolvePreferredServicePort({ CLAUDISH_SERVICE_PORT: "18000" })).toBe(18000);
  });

  test("falls back to default port when env is invalid", () => {
    expect(resolvePreferredServicePort({ CLAUDISH_SERVICE_PORT: "bad" })).toBe(17888);
  });

  test("warns and moves to the next port when preferred port is occupied", async () => {
    const server = await listenOnLocalhost(19888);

    try {
      const result = await findServicePort(19888);

      expect(result.port).toBe(19889);
      expect(result.warning).toContain("19888");
      expect(result.warning).toContain("19889");
    } finally {
      server.close();
    }
  });
});
