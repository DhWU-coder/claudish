/**
 * Helpers for terminal-size messages in the configuration TUI.
 */

export interface CompactConfigProviderSummary {
  id: string;
  defaultModel?: string;
}

export interface CompactConfigMenuInput {
  customProviders: CompactConfigProviderSummary[];
  defaultModel?: string;
  defaultProvider?: string;
  effectiveDefaultModel?: string;
  effectiveDefaultProvider?: string;
}

export interface CompactConfigMenuItem {
  detail: string;
  id: string;
  label: string;
}

/**
 * Build a concise fallback message for terminals that cannot fit the full TUI.
 */
export function getSmallTerminalMessage(width: number, height: number): string {
  return `Terminal too small (${width}x${height}). Resize to at least 60x15, or run: claudish config --web`;
}

/**
 * Use a compact menu when width is readable but height cannot fit the full TUI.
 */
export function shouldUseCompactConfigMenu(width: number, height: number): boolean {
  return width >= 60 && height < 15;
}

/**
 * Build the scrollable compact menu from the same state as the full config UI.
 */
export function buildCompactConfigMenuItems(
  input: CompactConfigMenuInput
): CompactConfigMenuItem[] {
  const items: CompactConfigMenuItem[] = [
    {
      detail: input.defaultProvider || input.effectiveDefaultProvider || "(not set)",
      id: "default-provider",
      label: "Default provider",
    },
    {
      detail: input.defaultModel || input.effectiveDefaultModel || "(interactive selector)",
      id: "default-model",
      label: "Default model",
    },
  ];

  for (const provider of input.customProviders) {
    items.push({
      detail: provider.defaultModel || "(no default model)",
      id: `custom-provider-${provider.id}`,
      label: `Provider ${provider.id}`,
    });
  }

  items.push({
    detail: "claudish web",
    id: "web-ui",
    label: "Open Web UI",
  });

  return items;
}

/**
 * Return the visible slice that keeps the selected compact menu row on screen.
 */
export function getCompactConfigWindow<T>(
  items: T[],
  selectedIndex: number,
  visibleRows: number
): { start: number; visibleItems: T[] } {
  const safeRows = Math.max(0, visibleRows);
  if (safeRows === 0 || items.length === 0) return { start: 0, visibleItems: [] };

  const boundedIndex = Math.min(Math.max(selectedIndex, 0), items.length - 1);
  const maxStart = Math.max(0, items.length - safeRows);
  const start = Math.min(Math.max(0, boundedIndex - safeRows + 1), maxStart);
  return {
    start,
    visibleItems: items.slice(start, start + safeRows),
  };
}
