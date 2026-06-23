import { describe, expect, test } from "bun:test";
import { getServiceCommand, isServiceCommand, isWebConfigCommand } from "./command-routing.js";

describe("command routing helpers", () => {
  test("isWebConfigCommand accepts the top-level web alias", () => {
    // `claudish web` should be as direct as `claudish config --web`.
    expect(isWebConfigCommand(["web"])).toBe(true);
    expect(isWebConfigCommand(["-y", "web"])).toBe(true);
  });

  test("isWebConfigCommand accepts existing config web forms", () => {
    // The new alias must preserve the older explicit Web UI spellings.
    expect(isWebConfigCommand(["config", "--web"])).toBe(true);
    expect(isWebConfigCommand(["config", "web"])).toBe(true);
  });

  test("isWebConfigCommand rejects normal config and prompt text", () => {
    // Ordinary config TUI and prompt invocations should not be stolen by the alias.
    expect(isWebConfigCommand(["config"])).toBe(false);
    expect(isWebConfigCommand(["make", "web", "page"])).toBe(false);
  });

  test("isWebConfigCommand rejects web when it is a flag value", () => {
    // A model or profile named "web" should still go through normal CLI mode.
    expect(isWebConfigCommand(["--model", "web", "hello"])).toBe(false);
  });

  test("isServiceCommand accepts top-level lifecycle commands", () => {
    expect(isServiceCommand(["start"])).toBe(true);
    expect(isServiceCommand(["stop"])).toBe(true);
    expect(isServiceCommand(["restart"])).toBe(true);
    expect(isServiceCommand(["status"])).toBe(true);
  });

  test("isServiceCommand rejects option values", () => {
    expect(isServiceCommand(["--model", "start", "hello"])).toBe(false);
  });

  test("getServiceCommand returns the lifecycle command", () => {
    expect(getServiceCommand(["-y", "start"])).toBe("start");
    expect(getServiceCommand(["--model", "status", "hello"])).toBeUndefined();
  });
});
