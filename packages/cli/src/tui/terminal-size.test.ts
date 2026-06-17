import { describe, expect, test } from "bun:test";
import {
  buildCompactConfigMenuItems,
  getCompactConfigWindow,
  getSmallTerminalMessage,
  shouldUseCompactConfigMenu,
} from "./terminal-size.js";

describe("terminal size helper", () => {
  test("getSmallTerminalMessage points cramped users to the Web UI", () => {
    // The desktop terminal can be wide but very short, so the message should
    // name the exact size and offer the Web UI escape hatch.
    expect(getSmallTerminalMessage(106, 7)).toContain("106x7");
    expect(getSmallTerminalMessage(106, 7)).toContain("claudish config --web");
  });

  test("shouldUseCompactConfigMenu allows short but readable terminals", () => {
    // A wide-but-short terminal should render a scrollable compact menu instead
    // of the old hard stop message.
    expect(shouldUseCompactConfigMenu(106, 10)).toBe(true);
    expect(shouldUseCompactConfigMenu(59, 10)).toBe(false);
    expect(shouldUseCompactConfigMenu(106, 15)).toBe(false);
  });

  test("buildCompactConfigMenuItems includes defaults, custom providers, and web hint", () => {
    const items = buildCompactConfigMenuItems({
      customProviders: [{ id: "tokenhub", defaultModel: "claude-opus-4-7-thinking" }],
      defaultModel: "gpt-5.5",
      defaultProvider: "cx",
      effectiveDefaultModel: "gpt-5.5",
      effectiveDefaultProvider: "cx",
    });

    // The fallback menu needs useful entries even when only a few rows fit.
    expect(items.map((item) => item.id)).toContain("default-provider");
    expect(items.map((item) => item.id)).toContain("default-model");
    expect(items.map((item) => item.id)).toContain("custom-provider-tokenhub");
    expect(items.map((item) => item.id)).toContain("web-ui");
  });

  test("getCompactConfigWindow keeps selection visible while scrolling", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      detail: `detail-${index}`,
      id: `item-${index}`,
      label: `Item ${index}`,
    }));

    const window = getCompactConfigWindow(items, 9, 4);

    // With only four visible rows, the selected item should stay inside the
    // returned slice rather than forcing users to resize the terminal.
    expect(window.start).toBe(6);
    expect(window.visibleItems.map((item) => item.id)).toEqual([
      "item-6",
      "item-7",
      "item-8",
      "item-9",
    ]);
  });
});
