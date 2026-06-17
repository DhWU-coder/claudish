/**
 * Project-local usage dashboard reader for the Web UI.
 *
 * The dashboard intentionally reads only `.claudish-usage/usage.jsonl` so it
 * does not pollute or reinterpret external Codex usage logs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDISH_USAGE_SCHEMA_VERSION = "claudish-usage.project-log.v1";
const USAGE_LOG_PATH = ".claudish-usage/usage.jsonl";

export interface UsageCounters {
  total: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface UsageDashboardGroup {
  name: string;
  requests: number;
  usage: UsageCounters;
}

export interface UsageDashboardRecentItem {
  timestamp: string;
  provider: string;
  model: string;
  cwd: string;
  apiSurface: string;
  requestId: string;
  usage: UsageCounters;
}

export interface UsageDashboardRange {
  preset: UsageRangePreset;
  start: string | null;
  end: string | null;
  bucket: UsageBucket;
}

export interface UsageDashboardTimelineProvider {
  name: string;
  requests: number;
  usage: UsageCounters;
}

export interface UsageDashboardTimelineItem {
  key: string;
  requests: number;
  usage: UsageCounters;
  providers: UsageDashboardTimelineProvider[];
}

export interface UsageDashboard {
  projectRoot: string;
  logPath: string;
  generatedAt: string;
  range: UsageDashboardRange;
  modelProvider: string;
  modelProviderOptions: string[];
  totalRequests: number;
  totals: UsageCounters;
  byProvider: UsageDashboardGroup[];
  byModel: UsageDashboardGroup[];
  byCwd: UsageDashboardGroup[];
  timeline: UsageDashboardTimelineItem[];
  recent: UsageDashboardRecentItem[];
}

export type UsageRangePreset = "today" | "week" | "month" | "all" | "recent" | "custom";

export type UsageBucket = "day" | "week" | "month";

export interface UsageDashboardOptions {
  projectRoot?: string;
  recentLimit?: number;
  preset?: string;
  recentValue?: string;
  startDate?: string;
  endDate?: string;
  bucket?: string;
  modelProvider?: string;
  now?: string;
}

interface UsageEvent {
  timestamp: string;
  provider: string;
  model: string;
  cwd: string;
  apiSurface: string;
  requestId: string;
  usage: UsageCounters;
}

interface ResolvedUsageRange {
  preset: UsageRangePreset;
  start: Date | null;
  end: Date | null;
  bucket: UsageBucket;
}

interface UsageTimelineAccumulator {
  key: string;
  requests: number;
  usage: UsageCounters;
  providers: Map<string, UsageDashboardGroup>;
}

/**
 * Read and aggregate the Claudish project-local usage log for the Web UI.
 */
export function getUsageDashboard(options: UsageDashboardOptions = {}): UsageDashboard {
  const projectRoot = resolveUsageProjectRoot(options.projectRoot);
  const logPath = join(projectRoot, USAGE_LOG_PATH);
  const events = readUsageEvents(logPath);
  const range = resolveUsageRange(options, events);
  const filteredEvents = filterEventsByRange(events, range);
  const modelProvider = normalizeModelProvider(options.modelProvider);
  const totals = emptyUsageCounters();
  const providerGroups = new Map<string, UsageDashboardGroup>();
  const modelGroups = new Map<string, UsageDashboardGroup>();
  const cwdGroups = new Map<string, UsageDashboardGroup>();
  const timelineGroups = new Map<string, UsageTimelineAccumulator>();

  for (const event of filteredEvents) {
    addUsage(totals, event.usage);
    addGroupUsage(providerGroups, event.provider, event.usage);
    addGroupUsage(cwdGroups, event.cwd, event.usage);
    addTimelineUsage(timelineGroups, bucketKey(event.timestamp, range.bucket), event);
  }

  for (const event of filteredEvents) {
    if (modelProvider !== "all" && event.provider !== modelProvider) continue;
    addGroupUsage(modelGroups, providerModelKey(event), event.usage);
  }

  return {
    projectRoot,
    logPath,
    generatedAt: new Date().toISOString(),
    range: serializeRange(range),
    modelProvider,
    modelProviderOptions: providerOptions(filteredEvents),
    totalRequests: filteredEvents.length,
    totals,
    byProvider: sortedGroups(providerGroups),
    byModel: sortedGroups(modelGroups),
    byCwd: sortedGroups(cwdGroups),
    timeline: sortedTimeline(timelineGroups),
    recent: recentEvents(filteredEvents, options.recentLimit ?? 20),
  };
}

/**
 * Resolve the root that owns `.claudish-usage`.
 */
function resolveUsageProjectRoot(projectRoot?: string): string {
  return projectRoot ?? process.env.CLAUDISH_USAGE_ROOT ?? resolveClaudishProjectRoot();
}

/**
 * Resolve the Claudish project/package root for Web UI terminal sessions.
 */
export function resolveClaudishProjectRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = walkUp(start, (dir) =>
    existsSync(join(dir, "packages", "cli", "package.json"))
  );
  if (sourceRoot) return sourceRoot;

  const packageRoot = walkUp(start, isClaudishPackageRoot);
  return packageRoot ?? process.cwd();
}

/**
 * Walk upward until a predicate recognizes the desired root.
 */
function walkUp(start: string, predicate: (dir: string) => boolean): string | undefined {
  let dir = start;
  while (true) {
    if (predicate(dir)) return dir;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Detect an installed claudish package root when source repo markers are absent.
 */
function isClaudishPackageRoot(dir: string): boolean {
  const packageJson = join(dir, "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf-8"));
    return parsed?.name === "claudish";
  } catch {
    return false;
  }
}

/**
 * Parse all valid usage rows from a JSONL file.
 */
function readUsageEvents(logPath: string): UsageEvent[] {
  if (!existsSync(logPath)) return [];

  return readFileSync(logPath, "utf-8")
    .split("\n")
    .map((line) => parseUsageLine(line.trim()))
    .filter((event): event is UsageEvent => Boolean(event));
}

/**
 * Convert one JSONL line into a normalized dashboard event.
 */
function parseUsageLine(line: string): UsageEvent | undefined {
  if (!line) return undefined;

  try {
    const parsed = JSON.parse(line);
    if (parsed?.schema_version !== CLAUDISH_USAGE_SCHEMA_VERSION) return undefined;

    const usage = normalizeUsageCounters(parsed.usage);
    if (!usage) return undefined;

    return {
      timestamp: stringField(parsed.timestamp) || "",
      provider: stringField(parsed.provider) || "unknown",
      model: stringField(parsed.model) || "unknown",
      cwd: stringField(parsed.cwd) || "unknown",
      apiSurface: stringField(parsed.api_surface) || "",
      requestId: stringField(parsed.request_id) || "",
      usage,
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the requested dashboard time range using local-day semantics.
 */
function resolveUsageRange(
  options: UsageDashboardOptions,
  events: UsageEvent[]
): ResolvedUsageRange {
  const preset = normalizePreset(options.preset);
  const bucket = normalizeBucket(options.bucket);
  const now = options.now ? new Date(options.now) : new Date();

  if (preset === "today") {
    return { preset, bucket, start: startOfLocalDay(now), end: endOfLocalDay(now) };
  }
  if (preset === "week") {
    return { preset, bucket, start: startOfLocalWeek(now), end: endOfLocalDay(now) };
  }
  if (preset === "month") {
    return {
      preset,
      bucket,
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now),
    };
  }
  if (preset === "custom") {
    return {
      preset,
      bucket,
      start: parseDateStart(options.startDate),
      end: parseDateEnd(options.endDate),
    };
  }
  if (preset === "recent") {
    const recent = recentDateRange(options.recentValue, now);
    if (recent) return { preset, bucket, ...recent };
  }

  return { preset: "all", bucket, ...allEventsRange(events) };
}

/**
 * Keep unknown presets from producing surprising empty dashboards.
 */
function normalizePreset(value: string | undefined): UsageRangePreset {
  if (
    value === "today" ||
    value === "week" ||
    value === "month" ||
    value === "recent" ||
    value === "custom"
  ) {
    return value;
  }
  return "all";
}

/**
 * Keep timeline buckets constrained to the supported UI choices.
 */
function normalizeBucket(value: string | undefined): UsageBucket {
  return value === "week" || value === "month" ? value : "day";
}

/**
 * Resolve the full range from available event timestamps.
 */
function allEventsRange(events: UsageEvent[]): Pick<ResolvedUsageRange, "start" | "end"> {
  const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  if (!times.length) return { start: null, end: null };
  return {
    start: startOfLocalDay(new Date(Math.min(...times))),
    end: endOfLocalDay(new Date(Math.max(...times))),
  };
}

/**
 * Filter events to the resolved time range and drop malformed timestamps.
 */
function filterEventsByRange(events: UsageEvent[], range: ResolvedUsageRange): UsageEvent[] {
  return events.filter((event) => {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) return false;
    if (range.start && time < range.start.getTime()) return false;
    if (range.end && time > range.end.getTime()) return false;
    return true;
  });
}

/**
 * Parse user-facing recent values such as 1天, 1周, 1个月, 半年, 一年.
 */
function parseRecentValue(value: string | undefined): { days?: number; months?: number } | null {
  const normalized = (value || "").trim();
  if (normalized === "半年") return { months: 6 };
  if (normalized === "一年") return { months: 12 };

  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) return { days: Number(dayMatch[1]) };

  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) return { days: Number(weekMatch[1]) * 7 };

  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) return { months: Number(monthMatch[1]) };

  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) return { months: Number(yearMatch[1]) * 12 };

  return null;
}

/**
 * Convert a recent value into a concrete local-date range.
 */
function recentDateRange(
  value: string | undefined,
  now: Date
): Pick<ResolvedUsageRange, "start" | "end"> | null {
  const parsed = parseRecentValue(value);
  if (!parsed) return null;
  const start = parsed.days
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - parsed.days)
    : subtractMonthsClamped(now, parsed.months ?? 1);
  return { start: startOfLocalDay(start), end: endOfLocalDay(now) };
}

/**
 * Subtract whole months while clamping end-of-month overflow.
 */
function subtractMonthsClamped(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/**
 * Parse a YYYY-MM-DD value as the start of a local day.
 */
function parseDateStart(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse a YYYY-MM-DD value as the end of a local day.
 */
function parseDateEnd(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Return the local day start for calendar-style filtering.
 */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Return the local day end for inclusive calendar-style filtering.
 */
function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/**
 * Return Monday as the start of the local week.
 */
function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

/**
 * Format a local date as YYYY-MM-DD for stable timeline bucket keys.
 */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Choose the timeline bucket key for one timestamp.
 */
function bucketKey(timestamp: string, bucket: UsageBucket): string {
  const date = new Date(timestamp);
  if (bucket === "month") return localDateKey(date).slice(0, 7);
  if (bucket === "week") return localDateKey(startOfLocalWeek(date));
  return localDateKey(date);
}

/**
 * Serialize date objects to JSON-friendly strings for the browser.
 */
function serializeRange(range: ResolvedUsageRange): UsageDashboardRange {
  return {
    preset: range.preset,
    start: range.start ? range.start.toISOString() : null,
    end: range.end ? range.end.toISOString() : null,
    bucket: range.bucket,
  };
}

/**
 * Accept real numeric provider counters and default optional details to zero.
 */
function normalizeUsageCounters(raw: unknown): UsageCounters | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const total = numberField(usage.total);
  const input = numberField(usage.input);
  const output = numberField(usage.output);
  if (total === undefined || input === undefined || output === undefined) return undefined;

  return {
    total,
    input,
    cached: numberField(usage.cached) ?? 0,
    output,
    reasoning: numberField(usage.reasoning) ?? 0,
  };
}

/**
 * Read a finite numeric counter without coercing strings.
 */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one string metadata field without coercing other values.
 */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Create a mutable zeroed usage counter object for aggregation.
 */
function emptyUsageCounters(): UsageCounters {
  return {
    total: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
  };
}

/**
 * Add one usage object into an aggregate counter.
 */
function addUsage(target: UsageCounters, usage: UsageCounters): void {
  target.total += usage.total;
  target.input += usage.input;
  target.cached += usage.cached;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
}

/**
 * Add one usage object into a named aggregate group.
 */
function addGroupUsage(
  groups: Map<string, UsageDashboardGroup>,
  name: string,
  usage: UsageCounters
): void {
  const group = groups.get(name) ?? {
    name,
    requests: 0,
    usage: emptyUsageCounters(),
  };
  group.requests += 1;
  addUsage(group.usage, usage);
  groups.set(name, group);
}

/**
 * Add one usage object into a timeline bucket.
 */
function addTimelineUsage(
  groups: Map<string, UsageTimelineAccumulator>,
  key: string,
  event: UsageEvent
): void {
  const group = groups.get(key) ?? {
    key,
    requests: 0,
    usage: emptyUsageCounters(),
    providers: new Map<string, UsageDashboardGroup>(),
  };
  group.requests += 1;
  addUsage(group.usage, event.usage);
  addGroupUsage(group.providers, event.provider, event.usage);
  groups.set(key, group);
}

/**
 * Build the model display key so duplicate model names remain provider-scoped.
 */
function providerModelKey(event: UsageEvent): string {
  return `${event.provider}@${event.model}`;
}

/**
 * Normalize the model provider filter selected by the browser.
 */
function normalizeModelProvider(value: string | undefined): string {
  const normalized = (value || "").trim();
  return normalized && normalized !== "all" ? normalized : "all";
}

/**
 * Return sorted provider names for the model distribution selector.
 */
function providerOptions(events: UsageEvent[]): string[] {
  return [...new Set(events.map((event) => event.provider))].sort((left, right) =>
    left.localeCompare(right)
  );
}

/**
 * Sort groups by total usage, then request count, then name for stable tables.
 */
function sortedGroups(groups: Map<string, UsageDashboardGroup>): UsageDashboardGroup[] {
  return [...groups.values()].sort(
    (left, right) =>
      right.usage.total - left.usage.total ||
      right.requests - left.requests ||
      left.name.localeCompare(right.name)
  );
}

/**
 * Sort timeline buckets from oldest to newest.
 */
function sortedTimeline(
  groups: Map<string, UsageTimelineAccumulator>
): UsageDashboardTimelineItem[] {
  return [...groups.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => ({
      key: group.key,
      requests: group.requests,
      usage: group.usage,
      providers: sortedGroups(group.providers),
    }));
}

/**
 * Return newest events first and cap the list for a compact dashboard.
 */
function recentEvents(events: UsageEvent[], limit: number): UsageDashboardRecentItem[] {
  return [...events]
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, Math.max(0, limit))
    .map((event) => ({ ...event }));
}
