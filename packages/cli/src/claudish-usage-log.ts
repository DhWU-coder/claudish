/**
 * Claudish project-local usage writer.
 *
 * This file records only provider-returned token counters and routing metadata.
 * It never stores prompts, model responses, headers, API keys, or OAuth tokens.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "claudish-usage.project-log.v1";
const SOURCE = "claudish";
const CHANNEL = "Claudish";

/**
 * Stable process-scoped session id used when callers do not provide one.
 */
const DEFAULT_SESSION_ID = `claudish-${Date.now()}-${randomUUID()}`;

export interface ClaudishUsageWriteInput {
  rawUsage: unknown;
  model: string;
  provider: string;
  apiSurface: string;
  auth?: string;
  projectRoot?: string;
  cwd?: string;
  sessionId?: string;
  requestId?: string;
  timestamp?: string;
}

interface NormalizedUsage {
  total: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

/**
 * Append one Claudish usage JSONL event when a provider returned real counters.
 */
export function writeClaudishUsageFromProviderUsage(input: ClaudishUsageWriteInput): boolean {
  const usage = normalizeProviderUsage(input.rawUsage);
  if (!usage) return false;

  const projectRoot = input.projectRoot ?? getClaudishUsageProjectRoot();
  const event = {
    schema_version: SCHEMA_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: SOURCE,
    channel: CHANNEL,
    provider: input.provider,
    ...(input.auth ? { auth: input.auth } : {}),
    api_surface: input.apiSurface,
    project_root: projectRoot,
    cwd: input.cwd ?? process.cwd(),
    session_id: input.sessionId ?? DEFAULT_SESSION_ID,
    ...(input.requestId ? { request_id: input.requestId } : {}),
    model: input.model,
    usage,
  };

  const usageDir = join(projectRoot, ".claudish-usage");
  mkdirSync(usageDir, { recursive: true });
  appendFileSync(join(usageDir, "usage.jsonl"), `${JSON.stringify(event)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return true;
}

/**
 * Normalize known provider usage payloads without estimating missing counters.
 */
function normalizeProviderUsage(rawUsage: unknown): NormalizedUsage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const input = readInputTokens(usage);
  const output = readOutputTokens(usage);
  const total = readTotalTokens(usage, input, output);

  if (total === undefined || input === undefined || output === undefined) {
    return undefined;
  }

  return {
    total,
    input,
    cached: readCachedTokens(usage),
    output,
    reasoning: readReasoningTokens(usage),
  };
}

/**
 * Read OpenAI/Responses/Gemini-style input token fields.
 */
function readInputTokens(usage: Record<string, unknown>): number | undefined {
  return (
    numberField(usage.input_tokens) ??
    numberField(usage.prompt_tokens) ??
    numberField(usage.promptTokenCount)
  );
}

/**
 * Read OpenAI/Responses/Gemini-style output token fields.
 */
function readOutputTokens(usage: Record<string, unknown>): number | undefined {
  return (
    numberField(usage.output_tokens) ??
    numberField(usage.completion_tokens) ??
    numberField(usage.candidatesTokenCount)
  );
}

/**
 * Use the provider total when present, otherwise sum real input/output counters.
 */
function readTotalTokens(
  usage: Record<string, unknown>,
  input: number | undefined,
  output: number | undefined
): number | undefined {
  const providerTotal = numberField(usage.total_tokens) ?? numberField(usage.totalTokenCount);
  if (providerTotal !== undefined) return providerTotal;
  if (input === undefined || output === undefined) return undefined;
  return input + output;
}

/**
 * Read a numeric field without coercing strings into fake token counts.
 */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract cached input tokens from known provider detail shapes.
 */
function readCachedTokens(usage: Record<string, unknown>): number {
  const direct =
    numberField(usage.cached_input_tokens) ?? numberField(usage.cachedContentTokenCount);
  if (direct !== undefined) return direct;

  const inputDetails = objectField(usage.input_tokens_details);
  const promptDetails = objectField(usage.prompt_tokens_details);
  return numberField(inputDetails?.cached_tokens) ?? numberField(promptDetails?.cached_tokens) ?? 0;
}

/**
 * Extract reasoning output tokens from known provider detail shapes.
 */
function readReasoningTokens(usage: Record<string, unknown>): number {
  const direct =
    numberField(usage.reasoning_output_tokens) ?? numberField(usage.thoughtsTokenCount);
  if (direct !== undefined) return direct;

  const outputDetails = objectField(usage.output_tokens_details);
  const completionDetails = objectField(usage.completion_tokens_details);
  return (
    numberField(outputDetails?.reasoning_tokens) ??
    numberField(completionDetails?.reasoning_tokens) ??
    0
  );
}

/**
 * Narrow nested usage detail objects before reading their fields.
 */
function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Resolve the Claudish repository root, defaulting logs to this project.
 */
function getClaudishUsageProjectRoot(): string {
  if (process.env.CLAUDISH_USAGE_ROOT) {
    return process.env.CLAUDISH_USAGE_ROOT;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, "packages", "cli", "package.json"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
