/**
 * codex-usage project-log writer for Claudish.
 *
 * This module writes only provider-returned token usage. It intentionally never
 * records prompts, completions, messages, API keys, OAuth tokens, or headers.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "codex-usage.project-log.v1";
const SOURCE = "claudish";
const CHANNEL = "Claudish";

/**
 * Stable process-scoped session id used when callers do not provide one.
 */
const DEFAULT_SESSION_ID = `claudish-${Date.now()}-${randomUUID()}`;

export interface CodexUsageWriteInput {
  rawUsage: unknown;
  model: string;
  provider: string;
  auth: string;
  apiSurface: string;
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
 * Append one codex-usage-compatible JSONL event when real usage is available.
 */
export function writeCodexUsageFromOpenAIUsage(input: CodexUsageWriteInput): boolean {
  const usage = normalizeOpenAIUsage(input.rawUsage);
  if (!usage) return false;

  const projectRoot = input.projectRoot ?? getClaudishProjectRoot();
  const event = {
    schema_version: SCHEMA_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: SOURCE,
    channel: CHANNEL,
    provider: input.provider,
    auth: input.auth,
    api_surface: input.apiSurface,
    project_root: projectRoot,
    cwd: input.cwd ?? process.cwd(),
    session_id: input.sessionId ?? DEFAULT_SESSION_ID,
    ...(input.requestId ? { request_id: input.requestId } : {}),
    model: input.model,
    usage,
  };

  const usageDir = join(projectRoot, ".codex-usage");
  mkdirSync(usageDir, { recursive: true });
  appendFileSync(join(usageDir, "usage.jsonl"), `${JSON.stringify(event)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return true;
}

/**
 * Map OpenAI-style usage payloads to the codex-usage schema.
 */
function normalizeOpenAIUsage(rawUsage: unknown): NormalizedUsage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const total = numberField(usage.total_tokens);
  const input = numberField(usage.input_tokens) ?? numberField(usage.prompt_tokens);
  const output = numberField(usage.output_tokens) ?? numberField(usage.completion_tokens);

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
 * Read a numeric field without coercing strings into fake token counts.
 */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract cached input tokens from known OpenAI usage detail shapes.
 */
function readCachedTokens(usage: Record<string, unknown>): number {
  const direct = numberField(usage.cached_input_tokens);
  if (direct !== undefined) return direct;

  const inputDetails = objectField(usage.input_tokens_details);
  const promptDetails = objectField(usage.prompt_tokens_details);
  return numberField(inputDetails?.cached_tokens) ?? numberField(promptDetails?.cached_tokens) ?? 0;
}

/**
 * Extract reasoning output tokens from known OpenAI usage detail shapes.
 */
function readReasoningTokens(usage: Record<string, unknown>): number {
  const direct = numberField(usage.reasoning_output_tokens);
  if (direct !== undefined) return direct;

  const outputDetails = objectField(usage.output_tokens_details);
  return numberField(outputDetails?.reasoning_tokens) ?? 0;
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
function getClaudishProjectRoot(): string {
  if (process.env.CLAUDISH_CODEX_USAGE_ROOT) {
    return process.env.CLAUDISH_CODEX_USAGE_ROOT;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, "packages", "cli", "package.json"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
