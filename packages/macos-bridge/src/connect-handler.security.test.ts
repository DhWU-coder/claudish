import { describe, expect, test } from "bun:test";
import { getSensitiveDebugDumpPath, isSensitiveDebugDumpEnabled } from "./connect-handler.js";

describe("sensitive bridge debug dumps", () => {
  test("are disabled by default", () => {
    expect(isSensitiveDebugDumpEnabled({})).toBe(false);
  });

  test("must be explicitly enabled", () => {
    expect(isSensitiveDebugDumpEnabled({ CLAUDISH_BRIDGE_DEBUG_DUMP: "1" })).toBe(true);
    expect(isSensitiveDebugDumpEnabled({ CLAUDISH_BRIDGE_DEBUG_DUMP: "true" })).toBe(false);
  });

  test("write under the bridge debug directory instead of /tmp", () => {
    const path = getSensitiveDebugDumpPath("traffic", "request.txt", "/Users/tester");
    expect(path).toBe("/Users/tester/.claudish-proxy/debug/traffic_request.txt");
    expect(path.startsWith("/tmp/")).toBe(false);
  });
});
