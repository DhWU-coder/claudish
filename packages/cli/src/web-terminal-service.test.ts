import { describe, expect, test } from "bun:test";
import {
  buildPythonTerminalCommand,
  parseTerminalSocketMessage,
  resolveTerminalModelSpec,
} from "./web-terminal-service.js";

describe("web terminal service", () => {
  test("resolveTerminalModelSpec prefixes bare models with the selected provider", () => {
    // Browser terminal launches must match the normal claudish provider@model shape.
    expect(resolveTerminalModelSpec({ provider: "cx", model: "gpt-5.5" })).toBe("cx@gpt-5.5");
  });

  test("resolveTerminalModelSpec keeps explicit provider model specs intact", () => {
    // Users can still type an explicit provider@model without being double-prefixed.
    expect(resolveTerminalModelSpec({ provider: "openrouter", model: "cx@gpt-5.5" })).toBe(
      "cx@gpt-5.5"
    );
  });

  test("buildPythonTerminalCommand creates a PTY wrapper for claudish", () => {
    // The Python bridge allocates a real PTY even when the web server itself
    // only has piped stdio.
    const command = buildPythonTerminalCommand({
      provider: "cx",
      model: "gpt-5.5",
      cols: 120,
      rows: 32,
      env: {},
    });

    expect(command.command).toBe("python3");
    expect(command.args[0]).toBe("-c");
    expect(command.args.slice(2)).toEqual(["claudish", "--model", "cx@gpt-5.5"]);
    expect(command.env.TERM).toBe("xterm-256color");
    expect(command.env.COLUMNS).toBe("120");
    expect(command.env.LINES).toBe("32");
  });

  test("buildPythonTerminalCommand preserves model names without shell quoting", () => {
    // The bridge passes arguments directly to execvp, so spaces never need a shell.
    const command = buildPythonTerminalCommand({
      provider: "corp",
      model: "model with spaces",
      cols: 80,
      rows: 24,
      env: {},
    });

    expect(command.command).toBe("python3");
    expect(command.args.slice(2)).toEqual(["claudish", "--model", "corp@model with spaces"]);
  });

  test("parseTerminalSocketMessage accepts typed input payloads", () => {
    // Browser WebSocket messages carry raw terminal input inside JSON envelopes.
    expect(parseTerminalSocketMessage(JSON.stringify({ type: "input", data: "hello" }))).toEqual({
      type: "input",
      data: "hello",
    });
  });

  test("parseTerminalSocketMessage accepts resize payloads", () => {
    // The browser reports xterm dimensions so PTY-capable backends can resize.
    expect(
      parseTerminalSocketMessage(JSON.stringify({ type: "resize", cols: 100, rows: 30 }))
    ).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
    });
  });
});
