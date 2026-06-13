import { describe, expect, test } from "bun:test";
import { isAllowedProxyOrigin } from "./proxy-server.js";

describe("proxy CORS origin policy", () => {
  test("allows non-browser requests without an Origin header", () => {
    expect(isAllowedProxyOrigin(undefined)).toBe(true);
    expect(isAllowedProxyOrigin("")).toBe(true);
  });

  test("allows loopback browser origins", () => {
    expect(isAllowedProxyOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedProxyOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedProxyOrigin("http://[::1]:8080")).toBe(true);
  });

  test("rejects remote browser origins", () => {
    expect(isAllowedProxyOrigin("https://evil.example")).toBe(false);
    expect(isAllowedProxyOrigin("http://192.168.1.10:3000")).toBe(false);
  });
});
