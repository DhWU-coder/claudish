/**
 * Local Web UI for editing ~/.claudish/config.json.
 *
 * This server is intentionally localhost-only and does not expose proxy
 * controls. It edits the same shared config helpers used by the terminal TUI.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CodexOAuth } from "./auth/codex-oauth.js";
import {
  type CustomProviderFormat,
  deleteCustomProvider,
  getConfigEditorState,
  getCustomProviderSecret,
  saveBuiltinProviderModels,
  saveGeneralDefaults,
  saveSimpleCustomProvider,
} from "./config-editor.js";
import type { CustomEndpointSimple } from "./config-schema.js";
import { type ClaudishProfileConfig, loadConfig } from "./profile-config.js";
import {
  type SaveFeishuAccountsInput,
  getFeishuAccountSecret,
  getFeishuAccountsEditorState,
  saveFeishuAccountsEditorState,
} from "./service/feishu-config-editor.js";
import {
  type CreatePythonTerminalSessionOptions,
  type WebTerminalSession,
  createPythonTerminalSession,
  parseTerminalSocketMessage,
  resolveTerminalModelSpec,
} from "./web-terminal-service.js";
import { getUsageDashboard, resolveClaudishProjectRoot } from "./web-usage-service.js";

type TerminalSessionFactory = (options: CreatePythonTerminalSessionOptions) => WebTerminalSession;
type OAuthLoginHandler = (providerId: string) => Promise<void>;

/** Opens a URL in the user's browser, injectable so tests never launch apps. */
type BrowserOpener = (url: string) => void;
type LocalFileOpener = (path: string) => void;

interface ProviderProbeRequestBody {
  provider?: string;
  model?: string;
  providerConfig?: ProviderProbeConfig;
}

interface ProviderProbeConfig {
  providerId?: unknown;
  format?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  defaultModel?: unknown;
  models?: unknown;
}

interface ProviderProbeInput {
  provider: string;
  model: string;
  modelSpec: string;
  prompt: string;
  cwd?: string;
  providerConfig?: ProviderProbeConfig;
}

interface ProviderProbeResult {
  ok: boolean;
  latencyMs: number;
  preview?: string;
  error?: string;
}

/** Runs a tiny real provider/model probe, injectable so tests never call LLMs. */
type ProviderProbeRunner = (input: ProviderProbeInput) => Promise<ProviderProbeResult>;
type ChannelStatusProvider = () => {
  channels: Array<{
    id: string;
    status: string;
    activeSessions?: number;
    [key: string]: unknown;
  }>;
};

interface TerminalSocketData {
  provider: string;
  model: string;
  cols: number;
  rows: number;
  cwd: string;
  session?: WebTerminalSession;
}

export interface ConfigWebServerOptions {
  port?: number;
  providerProbeRunner?: ProviderProbeRunner;
  /** Whether to open the local Web UI after binding the server port. */
  openBrowser?: boolean;
  /** Browser opener used for tests or platform-specific launch behavior. */
  browserOpener?: BrowserOpener;
  /** 本地文件打开器，测试中注入以避免真的启动系统应用。 */
  localFileOpener?: LocalFileOpener;
  oauthLogin?: OAuthLoginHandler;
  terminalSessionFactory?: TerminalSessionFactory;
  terminalWorkingDirectory?: string;
  usageProjectRoot?: string;
  channelStatusProvider?: ChannelStatusProvider;
}

export interface ConfigWebRequestOptions {
  providerProbeRunner?: ProviderProbeRunner;
  oauthLogin?: OAuthLoginHandler;
  usageProjectRoot?: string;
  channelStatusProvider?: ChannelStatusProvider;
  localFileOpener?: LocalFileOpener;
}

/**
 * Handle a single Web UI HTTP request.
 */
export async function handleConfigWebRequest(
  request: Request,
  options: ConfigWebRequestOptions = {}
): Promise<Response> {
  const url = new URL(request.url);

  try {
    return await dispatchConfigWebRequest(request, url, options);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

/**
 * Dispatch a Web UI request after top-level error handling is established.
 */
async function dispatchConfigWebRequest(
  request: Request,
  url: URL,
  options: ConfigWebRequestOptions
): Promise<Response> {
  if (request.method === "GET") {
    return handleGetRequest(url, options);
  }

  if (request.method === "POST") {
    return handlePostRequest(request, url, options);
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/custom-providers/")) {
    return handleCustomProviderDelete(url);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/**
 * Route read-only Web UI requests.
 */
function handleGetRequest(url: URL, options: ConfigWebRequestOptions): Response {
  if (url.pathname === "/") {
    return htmlResponse(renderConfigPage());
  }

  // Browsers request favicons automatically; return no content to avoid 404 logs.
  if (url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/config") {
    return jsonResponse(getPublicEditorState());
  }

  if (url.pathname === "/api/usage") {
    return jsonResponse(getUsageDashboard(usageDashboardOptionsFromUrl(url, options)));
  }

  if (url.pathname === "/api/channels") {
    return jsonResponse(
      options.channelStatusProvider?.() ?? {
        channels: [{ id: "feishu", status: "not_configured", activeSessions: 0 }],
      }
    );
  }

  if (url.pathname === "/api/feishu-config") {
    return jsonResponse(getFeishuAccountsEditorState());
  }

  if (url.pathname.startsWith("/api/feishu-config/") && url.pathname.endsWith("/secret")) {
    return handleFeishuAccountSecretGet(url);
  }

  if (url.pathname.startsWith("/api/custom-providers/") && url.pathname.endsWith("/secret")) {
    return handleCustomProviderSecretGet(url);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/**
 * Route mutating Web UI requests.
 */
function handlePostRequest(
  request: Request,
  url: URL,
  options: ConfigWebRequestOptions
): Promise<Response> | Response {
  if (url.pathname === "/api/defaults") {
    return handleDefaultsPost(request);
  }

  if (url.pathname === "/api/custom-providers") {
    return handleCustomProviderPost(request);
  }

  if (url.pathname.startsWith("/api/builtin-providers/")) {
    return handleBuiltinProviderPost(request, url);
  }

  if (url.pathname.startsWith("/api/oauth-login/")) {
    return handleOAuthLoginPost(url, options.oauthLogin ?? loginOAuthProvider);
  }

  if (url.pathname === "/api/open-local-file") {
    return handleOpenLocalFilePost(request, options);
  }

  if (url.pathname === "/api/feishu-config") {
    return handleFeishuConfigPost(request);
  }

  if (url.pathname === "/api/provider-test") {
    return handleProviderTestPost(
      request,
      options.providerProbeRunner ?? defaultProviderProbeRunner
    );
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/**
 * Convert the browser usage filters into service-layer dashboard options.
 */
function usageDashboardOptionsFromUrl(url: URL, options: ConfigWebRequestOptions) {
  return {
    projectRoot: options.usageProjectRoot,
    preset: url.searchParams.get("preset") ?? undefined,
    recentValue: url.searchParams.get("recentValue") ?? undefined,
    startDate: url.searchParams.get("startDate") ?? undefined,
    endDate: url.searchParams.get("endDate") ?? undefined,
    bucket: url.searchParams.get("bucket") ?? undefined,
    modelProvider: url.searchParams.get("modelProvider") ?? undefined,
    now: url.searchParams.get("now") ?? undefined,
  };
}

/**
 * Start the localhost-only Web UI server.
 */
export function startConfigWebServer(
  options: ConfigWebServerOptions = {}
): ReturnType<typeof Bun.serve> {
  const terminalSessionFactory = options.terminalSessionFactory ?? createPythonTerminalSession;
  const usageProjectRoot = options.usageProjectRoot ?? resolveClaudishProjectRoot();
  const terminalWorkingDirectory =
    options.terminalWorkingDirectory ??
    process.env.CLAUDISH_TERMINAL_CWD ??
    resolveClaudishProjectRoot();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch: (request, server) => {
      const url = new URL(request.url);

      // Web terminal streams use Bun's WebSocket upgrade path, while ordinary
      // config requests continue through the testable Fetch handler.
      if (url.pathname === "/api/terminal") {
        const upgraded = server.upgrade(request, {
          data: createTerminalSocketData(url, terminalWorkingDirectory),
        });
        return upgraded ? undefined : jsonResponse({ error: "WebSocket upgrade failed" }, 400);
      }

      return handleConfigWebRequest(request, {
        providerProbeRunner: options.providerProbeRunner,
        oauthLogin: options.oauthLogin,
        usageProjectRoot,
        channelStatusProvider: options.channelStatusProvider,
        localFileOpener: options.localFileOpener,
      });
    },
    websocket: createTerminalWebSocketHandler(terminalSessionFactory),
  });

  const webUiUrl = `http://127.0.0.1:${server.port}/`;
  console.log(`Claudish Config Web UI: ${webUiUrl}`);
  console.log("Press Ctrl+C to stop.");

  if (options.openBrowser) {
    openConfigWebBrowser(webUiUrl, options.browserOpener ?? openUrlInBrowser);
  }
  return server;
}

/**
 * Open the Web UI as a convenience without making browser failure fatal.
 */
function openConfigWebBrowser(url: string, opener: BrowserOpener): void {
  try {
    opener(url);
  } catch (err) {
    console.warn(
      `Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`
    );
    console.warn(`Open manually: ${url}`);
  }
}

/**
 * Dispatch to the host operating system's standard URL opener.
 */
function openUrlInBrowser(url: string): void {
  Bun.spawn({
    cmd: browserOpenCommand(url),
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Build an OS-specific command for opening a local URL.
 */
function browserOpenCommand(url: string): string[] {
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/**
 * Build the terminal socket metadata from the browser query string.
 */
function createTerminalSocketData(url: URL, cwd: string): TerminalSocketData {
  return {
    provider: url.searchParams.get("provider") ?? "",
    model: url.searchParams.get("model") ?? "",
    cols: Number(url.searchParams.get("cols") ?? 100),
    rows: Number(url.searchParams.get("rows") ?? 30),
    cwd,
  };
}

/**
 * Wire a WebSocket to one real claudish terminal session.
 */
function createTerminalWebSocketHandler(
  terminalSessionFactory: TerminalSessionFactory
): Bun.WebSocketHandler<TerminalSocketData> {
  return {
    open(ws) {
      try {
        ws.data.session = terminalSessionFactory({
          provider: ws.data.provider,
          model: ws.data.model,
          cols: ws.data.cols,
          rows: ws.data.rows,
          cwd: ws.data.cwd,
          onData: (chunk) => sendTerminalChunk(ws, chunk),
          onExit: (code) => {
            sendTerminalText(ws, `\r\n[claudish exited with code ${code ?? "signal"}]\r\n`);
            ws.close();
          },
          onError: (error) => {
            sendTerminalText(ws, `\r\n[terminal error: ${error.message}]\r\n`);
            ws.close();
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendTerminalText(ws, `\r\n[terminal error: ${message}]\r\n`);
        ws.close();
      }
    },
    message(ws, rawMessage) {
      const message = parseTerminalSocketMessage(
        typeof rawMessage === "string" ? rawMessage : Buffer.from(rawMessage)
      );
      if (!message) return;

      if (message.type === "input") {
        ws.data.session?.write(message.data);
      } else if (message.type === "resize") {
        ws.data.session?.resize(message.cols, message.rows);
      } else {
        ws.data.session?.kill();
        ws.close();
      }
    },
    close(ws) {
      ws.data.session?.kill();
      ws.data.session = undefined;
    },
  };
}

/**
 * Send raw PTY bytes to xterm.js without crashing closed sockets.
 */
function sendTerminalChunk(
  ws: Bun.ServerWebSocket<TerminalSocketData>,
  chunk: string | Uint8Array
): void {
  try {
    ws.send(chunk);
  } catch {
    // Closed browser tabs race with child process output; the close handler
    // will terminate the associated session.
  }
}

/**
 * Send a short terminal status line as UTF-8 text.
 */
function sendTerminalText(ws: Bun.ServerWebSocket<TerminalSocketData>, text: string): void {
  sendTerminalChunk(ws, text);
}

/**
 * Persist defaults from a POST body and return the updated state.
 */
async function handleDefaultsPost(request: Request): Promise<Response> {
  const body = await readJson<{
    defaultModel?: string;
    defaultProvider?: string;
  }>(request);
  saveGeneralDefaults({
    defaultModel: body.defaultModel ?? "",
    defaultProvider: body.defaultProvider ?? "",
  });
  return jsonResponse(getPublicEditorState());
}

/**
 * 保存 Web 端编辑的飞书账号，并交给后台热更新监听器自动生效。
 */
async function handleFeishuConfigPost(request: Request): Promise<Response> {
  const body = await readJson<SaveFeishuAccountsInput>(request);
  return jsonResponse(saveFeishuAccountsEditorState(body));
}

function handleFeishuAccountSecretGet(url: URL): Response {
  const accountId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  const secret = getFeishuAccountSecret(accountId);
  if (!secret) return jsonResponse({ error: "Feishu account secret not found." }, 404);
  return jsonResponse(secret);
}

/**
 * Persist a simple custom provider from a POST body and return the updated state.
 */
async function handleCustomProviderPost(request: Request): Promise<Response> {
  const body = await readJson<{
    providerId?: string;
    format?: CustomProviderFormat;
    baseUrl?: string;
    apiKey?: string;
    defaultModel?: string;
    models?: string[] | string;
  }>(request);
  saveSimpleCustomProvider({
    providerId: body.providerId ?? "",
    format: body.format ?? "openai",
    baseUrl: body.baseUrl ?? "",
    apiKey: body.apiKey ?? "",
    defaultModel: body.defaultModel ?? "",
    models: body.models ?? "",
  });
  return jsonResponse(getPublicEditorState());
}

/**
 * Persist model metadata for a builtin provider without replacing its transport.
 */
async function handleBuiltinProviderPost(request: Request, url: URL): Promise<Response> {
  const providerId = decodeURIComponent(url.pathname.replace("/api/builtin-providers/", ""));
  const body = await readJson<{
    apiKey?: string;
    defaultModel?: string;
    models?: string[] | string;
  }>(request);
  saveBuiltinProviderModels({
    providerId,
    apiKey: body.apiKey ?? "",
    defaultModel: body.defaultModel ?? "",
    models: body.models ?? "",
  });
  return jsonResponse(getPublicEditorState());
}

/**
 * Trigger a browser-based OAuth login flow from the local Web UI.
 */
async function handleOAuthLoginPost(url: URL, oauthLogin: OAuthLoginHandler): Promise<Response> {
  const providerId = decodeURIComponent(url.pathname.replace("/api/oauth-login/", ""));
  await oauthLogin(providerId);
  return jsonResponse({ ok: true, state: getPublicEditorState() });
}

/**
 * Run the supported builtin OAuth login flow for the requested provider.
 */
async function loginOAuthProvider(providerId: string): Promise<void> {
  const normalized = providerId.trim().toLowerCase();
  if (!["cx", "codex", "openai-codex"].includes(normalized)) {
    throw new Error(`Provider '${providerId}' does not support Web OAuth login`);
  }
  await CodexOAuth.getInstance().login();
}

async function handleOpenLocalFilePost(
  request: Request,
  options: ConfigWebRequestOptions
): Promise<Response> {
  const body = await readJson<{ path?: unknown }>(request);
  const filePath = typeof body.path === "string" ? body.path.trim() : "";
  if (!filePath) return jsonResponse({ error: "Missing file path" }, 400);

  const resolvedPath = resolve(filePath);
  const allowedRoots = feishuFileCacheRoots(options);
  if (!allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return jsonResponse({ error: "Only Feishu file cache files can be opened." }, 403);
  }
  if (!existsSync(resolvedPath)) return jsonResponse({ error: "File not found" }, 404);

  (options.localFileOpener ?? openLocalFile)(resolvedPath);
  return jsonResponse({ ok: true });
}

function feishuFileCacheRoots(options: ConfigWebRequestOptions): string[] {
  const status = options.channelStatusProvider?.();
  return (status?.channels ?? [])
    .filter((channel) => channel.id === "feishu" || channel.id.startsWith("feishu:"))
    .map((channel) => (typeof channel.cwd === "string" ? channel.cwd.trim() : ""))
    .filter(Boolean)
    .map((cwd) => resolve(cwd, "feishu-files"));
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  return path.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`);
}

function openLocalFile(path: string): void {
  Bun.spawn({
    cmd: browserOpenCommand(path),
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Delete a custom provider named in the URL path.
 */
function handleCustomProviderDelete(url: URL): Response {
  const providerId = decodeURIComponent(url.pathname.replace("/api/custom-providers/", ""));
  const deleted = deleteCustomProvider(providerId);
  return jsonResponse({ deleted, state: getPublicEditorState() });
}

/**
 * Return a saved provider key only for an explicit reveal request.
 */
function handleCustomProviderSecretGet(url: URL): Response {
  const providerId = decodeCustomProviderSecretId(url);
  if (!providerId) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const apiKey = getCustomProviderSecret(providerId);
  if (!apiKey) {
    return jsonResponse({ error: "Provider secret not found" }, 404);
  }

  return jsonResponse({ apiKey });
}

/**
 * Extract the provider id from /api/custom-providers/:id/secret.
 */
function decodeCustomProviderSecretId(url: URL): string | undefined {
  const prefix = "/api/custom-providers/";
  const suffix = "/secret";
  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(suffix)) return undefined;
  const encoded = url.pathname.slice(prefix.length, -suffix.length);
  return encoded ? decodeURIComponent(encoded) : undefined;
}

/**
 * Run a tiny provider/model probe through the real claudish CLI path.
 */
async function handleProviderTestPost(
  request: Request,
  providerProbeRunner: ProviderProbeRunner
): Promise<Response> {
  const body = await readJson<ProviderProbeRequestBody>(request);
  const provider = body.provider?.trim() ?? "";
  const model = body.model?.trim() ?? "";
  const startedAt = Date.now();

  if (!provider || !model) {
    return jsonResponse({ ok: false, error: "Choose a provider and model first.", latencyMs: 0 });
  }

  try {
    const result = await providerProbeRunner({
      provider,
      model,
      modelSpec: resolveTerminalModelSpec({ provider, model }),
      prompt: "回我hi",
      providerConfig: body.providerConfig,
    });
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startedAt,
    });
  }
}

/**
 * Spawn a short-lived claudish command so model tests match terminal chat.
 */
async function defaultProviderProbeRunner(input: ProviderProbeInput): Promise<ProviderProbeResult> {
  const startedAt = Date.now();
  const probeHome = createProbeHomeIfNeeded(input);
  const cleanup = () => {
    // Temporary homes exist only to test unsaved provider edits.
    if (probeHome) rmSync(probeHome, { recursive: true, force: true });
  };

  try {
    const proc = Bun.spawn({
      cmd: [
        "claudish",
        "--model",
        input.modelSpec,
        "--no-session-persistence",
        "--quiet",
        input.prompt,
      ],
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(probeHome ? { CLAUDISH_HOME: probeHome } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitResult = await waitForProbeExit(proc, 30_000);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const latencyMs = Date.now() - startedAt;

    if (exitResult === "timeout") {
      return { ok: false, latencyMs, error: "Probe timed out after 30s" };
    }

    if (exitResult !== 0) {
      return { ok: false, latencyMs, error: compactProbeOutput(stderr || stdout) };
    }

    return { ok: true, latencyMs, preview: compactProbeOutput(stdout) };
  } finally {
    cleanup();
  }
}

/**
 * Wait for a probe process, killing it if the tiny request stalls.
 */
async function waitForProbeExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number
): Promise<number | "timeout"> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      proc.kill();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    return await Promise.race([proc.exited, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Create a temporary CLAUDISH_HOME when the browser sends unsaved provider edits.
 */
function createProbeHomeIfNeeded(input: ProviderProbeInput): string | undefined {
  const providerEntry = buildTemporaryProviderEntry(input);
  if (!providerEntry) return undefined;

  const config = loadConfig();
  const tempHome = mkdtempSync(join(tmpdir(), "claudish-provider-test-"));
  const tempConfig: ClaudishProfileConfig = {
    ...config,
    customEndpoints: {
      ...(config.customEndpoints ?? {}),
      [input.provider]: providerEntry,
    },
  };

  // The temp config shadows only this child process via CLAUDISH_HOME.
  writeFileSync(join(tempHome, "config.json"), JSON.stringify(tempConfig, null, 2), "utf-8");
  return tempHome;
}

/**
 * Convert the provider modal payload into a simple custom endpoint override.
 */
function buildTemporaryProviderEntry(input: ProviderProbeInput): CustomEndpointSimple | undefined {
  const config = input.providerConfig;
  if (!config) return undefined;

  const format = stringField(config.format);
  const baseUrl = stringField(config.baseUrl);
  if (!isSimpleProviderFormat(format) || !baseUrl) return undefined;

  const savedConfig = loadConfig();
  const existingApiKey = existingCustomEndpointApiKey(savedConfig, input.provider);
  const apiKey = stringField(config.apiKey) || existingApiKey;
  if (!apiKey) return undefined;

  const defaultModel = stringField(config.defaultModel) || input.model;
  return {
    kind: "simple",
    url: baseUrl.replace(/\/+$/, ""),
    format,
    apiKey,
    defaultModel,
    models: normalizeProbeModels(config.models, defaultModel),
  };
}

/**
 * Read the existing key so masked-key edits can still test saved providers.
 */
function existingCustomEndpointApiKey(
  config: ClaudishProfileConfig,
  provider: string
): string | undefined {
  const endpoint = config.customEndpoints?.[provider];
  if (!endpoint || typeof endpoint !== "object") return undefined;
  const apiKey = (endpoint as Record<string, unknown>).apiKey;
  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
}

/**
 * Accept only simple endpoint formats that custom provider routing can load.
 */
function isSimpleProviderFormat(value: string): value is CustomProviderFormat {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

/**
 * Normalize model lists sent either as arrays or form-style newline strings.
 */
function normalizeProbeModels(modelsInput: unknown, defaultModel: string): string[] {
  const values = Array.isArray(modelsInput)
    ? modelsInput
    : typeof modelsInput === "string"
      ? modelsInput.split(/\r?\n/)
      : [];
  const models = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
  return Array.from(new Set(models));
}

/**
 * Extract a compact one-line message for model-row test status.
 */
function compactProbeOutput(text: string): string {
  // Build the ANSI escape matcher without embedding an ESC literal in source.
  const escapeChar = String.fromCharCode(27);
  const ansiEscapePattern = new RegExp(`${escapeChar}\\[[0-9;?]*[ -/]*[@-~]`, "g");
  const compact = text
    .replace(ansiEscapePattern, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return (compact || "No output").slice(0, 240);
}

/**
 * Safely coerce loose browser form fields into trimmed strings.
 */
function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse JSON request bodies with a small guard for empty payloads.
 */
async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Return JSON with a consistent content type.
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Return HTML with a consistent content type.
 */
function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Build a browser-safe state object that does not echo full API keys.
 */
function getPublicEditorState() {
  const state = getConfigEditorState();
  return {
    ...state,
    customProviders: state.customProviders.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskSecret(provider.apiKey) : "",
    })),
  };
}

/**
 * Mask secrets before rendering them into the browser.
 */
function maskSecret(value: string): string {
  if (value.length <= 8) return "configured";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

/**
 * Render the static HTML shell; browser-side JS calls the JSON API above.
 */
function renderConfigPage(): string {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claudish Config</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f6f7f9;
        --panel: #ffffff;
        --panel-2: #f9fafb;
        --text: #18202a;
        --muted: #687384;
        --line: #d8dde6;
        --accent: #0f7b6c;
        --accent-strong: #0a5e53;
        --accent-soft: #dff4ef;
        --danger: #b3261e;
        --danger-soft: #f8dfdc;
        --field: #fbfcfd;
        --shadow: 0 12px 28px rgba(24, 32, 42, 0.08);
      }
      :root[data-theme="dark"] {
        --bg: #101214;
        --panel: #171a1f;
        --panel-2: #20242a;
        --text: #edf1f5;
        --muted: #9aa6b5;
        --line: #303640;
        --accent: #22a991;
        --accent-strong: #3cc4ad;
        --accent-soft: #183931;
        --danger: #ff8a80;
        --danger-soft: #3f2222;
        --field: #121519;
        --shadow: 0 14px 30px rgba(0, 0, 0, 0.34);
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --bg: #101214;
          --panel: #171a1f;
          --panel-2: #20242a;
          --text: #edf1f5;
          --muted: #9aa6b5;
          --line: #303640;
          --accent: #22a991;
          --accent-strong: #3cc4ad;
          --accent-soft: #183931;
          --danger: #ff8a80;
          --danger-soft: #3f2222;
          --field: #121519;
          --shadow: 0 14px 30px rgba(0, 0, 0, 0.34);
        }
      }
      * {
        box-sizing: border-box;
      }
      /* Keep hidden attributes authoritative over component display rules. */
      [hidden] {
        display: none !important;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body.chat-active {
        overflow: hidden;
      }
      header {
        min-height: 58px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 22px;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }
      main {
        width: 100%;
        max-width: none;
        margin: 0;
        padding: 18px 28px;
      }
      body.chat-active main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        height: calc(100vh - 58px);
        width: 100%;
        min-height: 0;
      }
      .tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 14px;
      }
      .tab {
        min-width: 86px;
        background: transparent;
        color: var(--muted);
        border-color: var(--line);
      }
      .tab.active {
        background: var(--accent-soft);
        color: var(--accent-strong);
        border-color: var(--accent);
      }
      .panel {
        display: none;
      }
      .panel.active {
        display: grid;
        gap: 16px;
      }
      .config-grid {
        display: grid;
        grid-template-columns: minmax(360px, 0.55fr) minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .section-head h2 {
        margin-bottom: 0;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
        box-shadow: var(--shadow);
      }
      h1,
      h2 {
        margin: 0;
        letter-spacing: 0;
      }
      h1 {
        font-size: 18px;
      }
      h2 {
        font-size: 14px;
        margin-bottom: 12px;
      }
      .header-actions,
      .button-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .source {
        color: var(--muted);
        font-size: 12px;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .field-help {
        color: var(--muted);
        font-size: 11px;
      }
      input,
      textarea,
      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        color: var(--text);
        padding: 9px 10px;
        font: inherit;
      }
      input,
      select {
        height: 38px;
      }
      textarea {
        min-height: 84px;
        resize: vertical;
      }
      button {
        height: 34px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: var(--accent);
        color: #ffffff;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover {
        background: var(--accent-strong);
      }
      button.ghost {
        background: transparent;
        color: var(--text);
        border-color: var(--line);
      }
      .theme-toggle {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        padding: 0;
      }
      .theme-icon {
        position: relative;
        display: block;
        width: 18px;
        height: 18px;
        color: currentColor;
      }
      .theme-toggle[data-target-theme="light"] .theme-icon {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: currentColor;
        box-shadow:
          0 -7px 0 -4px currentColor,
          0 7px 0 -4px currentColor,
          7px 0 0 -4px currentColor,
          -7px 0 0 -4px currentColor,
          5px 5px 0 -4px currentColor,
          -5px -5px 0 -4px currentColor,
          5px -5px 0 -4px currentColor,
          -5px 5px 0 -4px currentColor;
      }
      .theme-toggle[data-target-theme="dark"] .theme-icon {
        border-radius: 50%;
        background: currentColor;
      }
      .theme-toggle[data-target-theme="dark"] .theme-icon::after {
        content: "";
        position: absolute;
        top: -2px;
        left: 6px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--panel);
      }
      .language-toggle {
        min-width: 54px;
        height: 38px;
        padding: 0 10px;
        font-size: 12px;
      }
      button.secondary {
        background: transparent;
        color: var(--danger);
        border-color: var(--danger);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      body.modal-open {
        overflow: hidden;
      }
      .combo {
        position: relative;
      }
      .combo input {
        padding-right: 42px;
      }
      .combo-toggle {
        position: absolute;
        top: 1px;
        right: 1px;
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border: 0;
        border-left: 1px solid var(--line);
        border-radius: 0 5px 5px 0;
        background: transparent;
        color: var(--muted);
        padding: 0;
      }
      .combo-toggle::before {
        content: "";
        width: 8px;
        height: 8px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg) translateY(-2px);
      }
      .combo-toggle:hover {
        background: var(--panel-2);
        color: var(--text);
      }
      .combo.locked input {
        color: var(--muted);
      }
      .combo.locked .combo-toggle {
        pointer-events: none;
      }
      .secret-field {
        position: relative;
      }
      .secret-field input {
        padding-right: 42px;
      }
      .secret-toggle {
        position: absolute;
        top: 1px;
        right: 1px;
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border: 0;
        border-left: 1px solid var(--line);
        border-radius: 0 5px 5px 0;
        background: transparent;
        color: var(--muted);
        padding: 0;
      }
      .secret-toggle::before {
        content: "";
        width: 16px;
        height: 10px;
        border: 2px solid currentColor;
        border-radius: 50%;
      }
      .secret-toggle::after {
        content: "";
        position: absolute;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: currentColor;
      }
      .secret-toggle:hover {
        background: var(--panel-2);
        color: var(--text);
      }
      .provider-model-editor {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
      }
      .provider-model-add-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 38px;
        gap: 8px;
        align-items: center;
      }
      .model-add-button,
      .provider-model-remove {
        display: grid;
        place-items: center;
        width: 38px;
        padding: 0;
        font-size: 18px;
      }
      .provider-model-list {
        display: grid;
        gap: 6px;
        max-height: min(420px, calc(100vh - 360px));
        overflow: auto;
      }
      .provider-model-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(104px, auto) auto;
        gap: 8px;
        align-items: center;
        min-height: 34px;
        padding: 5px 6px 5px 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
      }
      .provider-model-row code {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .provider-model-test-status {
        overflow: hidden;
        color: var(--muted);
        font-size: 11px;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .provider-model-test-status.ok {
        color: var(--accent-strong);
      }
      .provider-model-test-status.error {
        color: var(--danger);
      }
      .provider-model-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .provider-model-test {
        min-width: 48px;
        padding: 0 9px;
      }
      .provider-model-remove {
        width: 30px;
        height: 28px;
        color: var(--danger);
      }
      .provider-model-empty {
        color: var(--muted);
        border: 1px dashed var(--line);
        border-radius: 6px;
        padding: 8px 10px;
      }
      .config-channel-summary-section {
        grid-column: 1 / -1;
      }
      .channel-overview-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .channel-overview-card,
      .channel-list-card {
        display: grid;
        gap: 6px;
        min-width: 0;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
      }
      .channel-overview-card strong,
      .channel-list-card strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .channel-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .channel-metric {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 0 7px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        font-size: 11px;
      }
      .channel-list {
        display: grid;
        gap: 10px;
      }
      .channel-list-card {
        height: auto;
        width: 100%;
        color: var(--text);
        text-align: left;
        box-shadow: none;
      }
      .channel-list-card:hover,
      .channel-list-card.active {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: var(--text);
      }
      .channel-detail {
        min-width: 0;
      }
      .feishu-channel-detail {
        display: grid;
        gap: 12px;
      }
      .feishu-channel-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .feishu-account-list {
        display: grid;
        gap: 10px;
      }
      .feishu-account-card {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
      }
      .feishu-account-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .feishu-account-title {
        display: grid;
        gap: 3px;
        min-width: 0;
      }
      .feishu-account-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }
      .feishu-account-fields {
        display: grid;
        grid-template-columns: repeat(4, minmax(150px, 1fr));
        gap: 10px;
      }
      .feishu-account-flags {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }
      .check-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
        font-size: 12px;
      }
      .check-row input {
        width: 16px;
        height: 16px;
      }
      .readonly-field input {
        color: var(--muted);
      }
      .feishu-account-sessions {
        display: grid;
        gap: 8px;
        padding-top: 2px;
      }
      .feishu-session-list {
        display: grid;
        gap: 8px;
      }
      .feishu-session-row {
        display: grid;
        grid-template-columns: minmax(90px, 0.8fr) minmax(0, 1.6fr) minmax(96px, 0.7fr) minmax(70px, 0.55fr) minmax(92px, auto);
        gap: 8px;
        align-items: center;
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
      }
      .feishu-session-row span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .combo-menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 30;
        display: none;
        width: 100%;
        max-height: 238px;
        overflow: auto;
        padding: 6px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }
      .combo.open .combo-menu {
        display: grid;
        gap: 3px;
      }
      .combo-option,
      .combo-empty {
        min-height: 32px;
        height: auto;
        width: 100%;
        justify-content: flex-start;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--text);
        padding: 7px 9px;
        text-align: left;
        font-weight: 500;
      }
      .combo-option:hover,
      .combo-option.active {
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .combo-empty {
        color: var(--muted);
        cursor: default;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: grid;
        place-items: center;
        padding: 22px;
        background: rgba(0, 0, 0, 0.56);
      }
      .modal-backdrop[hidden] {
        display: none;
      }
      .modal {
        width: min(980px, calc(100vw - 44px));
        max-height: min(760px, calc(100vh - 44px));
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 16px 0;
      }
      .modal-head h2 {
        margin-bottom: 0;
      }
      .modal-body {
        padding: 16px;
      }
      /* Split provider credentials from model management on desktop. */
      .provider-editor-grid {
        display: grid;
        grid-template-columns: minmax(0, 0.95fr) minmax(320px, 1.05fr);
        gap: 16px;
        align-items: start;
      }
      .provider-editor-info,
      .provider-editor-models {
        display: grid;
        gap: 12px;
        min-width: 0;
      }
      .provider-editor-models {
        min-height: 0;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding-top: 4px;
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .table {
        display: grid;
        border: 1px solid var(--line);
        border-radius: 6px;
        overflow: hidden;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(130px, 1fr) 110px 110px minmax(160px, 1fr) 156px;
        gap: 10px;
        align-items: center;
        min-height: 44px;
        padding: 8px 10px;
        border-top: 1px solid var(--line);
      }
      .row:first-child {
        border-top: 0;
      }
      .head {
        background: var(--panel-2);
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .provider-model-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: max-content;
        max-width: 100%;
        height: 30px;
        padding: 0 9px;
        background: transparent;
        color: var(--text);
        border-color: var(--line);
      }
      .provider-model-toggle::after {
        content: "";
        width: 7px;
        height: 7px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg) translateY(-2px);
      }
      .provider-model-toggle.expanded::after {
        transform: rotate(225deg) translate(-1px, -1px);
      }
      .provider-model-detail {
        display: grid;
        gap: 8px;
        padding: 10px;
        border-top: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel-2) 74%, transparent);
      }
      .provider-model-command-row {
        display: grid;
        grid-template-columns: minmax(150px, 0.7fr) minmax(260px, 1fr) 34px;
        gap: 10px;
        align-items: center;
        min-width: 0;
        padding: 7px 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel);
      }
      .provider-model-command-row code,
      .provider-model-command {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .provider-model-command {
        color: var(--muted);
      }
      .copy-command-button {
        position: relative;
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        padding: 0;
      }
      .copy-command-button::before,
      .copy-command-button::after {
        content: "";
        position: absolute;
        width: 12px;
        height: 14px;
        border: 2px solid currentColor;
        border-radius: 3px;
      }
      .copy-command-button::before {
        transform: translate(3px, -3px);
        opacity: 0.55;
      }
      .copy-command-button::after {
        background: var(--panel);
        transform: translate(-2px, 2px);
      }
      .copy-command-button.copied {
        color: var(--accent-strong);
        border-color: var(--accent);
      }
      code {
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
      }
      #status {
        color: var(--accent);
        min-height: 20px;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .terminal-shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 12px;
        height: 100%;
        min-height: 0;
      }
      .terminal-toolbar {
        display: grid;
        grid-template-columns: minmax(170px, 220px) minmax(180px, 1fr) auto minmax(220px, auto);
        gap: 12px;
        align-items: end;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }
      .terminal-tool {
        display: grid;
        gap: 6px;
      }
      .field-label {
        color: var(--muted);
        font-size: 12px;
      }
      .terminal-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px 12px;
        min-width: 0;
      }
      .terminal-frame {
        min-height: 0;
        border: 1px solid var(--line);
        border-radius: 6px;
        display: grid;
        background: #0b0f12;
        overflow: hidden;
      }
      #terminal {
        min-height: 0;
        width: 100%;
        height: 100%;
        padding: 8px;
      }
      .terminal-actions {
        display: flex;
        gap: 8px;
        align-items: end;
      }
      .channels-grid {
        display: grid;
        grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      .channel-summary {
        display: grid;
        gap: 10px;
        min-height: 94px;
      }
      .channel-status-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
      }
      .channel-status-row span:first-child {
        color: var(--muted);
        font-size: 12px;
      }
      .channel-messages {
        grid-column: 1 / -1;
        min-width: 0;
      }
      .channel-message-table-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 6px;
      }
      .channel-message-table {
        width: 100%;
        min-width: 920px;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .channel-message-table th,
      .channel-message-table td {
        overflow: hidden;
        padding: 9px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .channel-message-table th {
        background: var(--panel-2);
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .channel-message-table tr:last-child td {
        border-bottom: 0;
      }
      .channel-message-stage {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        height: 24px;
        padding: 0 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        color: var(--text);
        font-size: 12px;
        font-weight: 600;
      }
      .channel-message-stage.completed {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .channel-message-stage.failed {
        border-color: var(--danger);
        background: var(--danger-soft);
        color: var(--danger);
      }
      .channel-message-stage.stopped {
        color: var(--muted);
      }
      .channel-message-error-button,
      .channel-session-detail-button {
        width: 100%;
        height: 26px;
        justify-content: flex-start;
        overflow: hidden;
        padding: 0 8px;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .channel-message-error-button {
        color: var(--danger);
      }
      .channel-message-detail-row td {
        padding: 0;
        background: var(--panel-2);
      }
      .channel-message-detail {
        display: grid;
        gap: 8px;
        padding: 12px;
        border-top: 1px solid var(--line);
      }
      .channel-message-detail-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      .channel-message-detail-item {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .channel-message-detail-item span {
        color: var(--muted);
        font-size: 11px;
      }
      .channel-message-detail-item code,
      .channel-message-error-text,
      .channel-session-output-text {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .channel-message-error-text,
      .channel-session-output-text {
        margin: 0;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        font: 12px/1.45 "SFMono-Regular", Consolas, monospace;
      }
      .channel-message-error-text {
        color: var(--danger);
      }
      body.drawer-open {
        overflow: hidden;
      }
      .feishu-session-drawer {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        justify-content: flex-end;
      }
      .feishu-drawer-backdrop {
        position: absolute;
        inset: 0;
        height: auto;
        border: 0;
        border-radius: 0;
        background: rgba(0, 0, 0, 0.48);
      }
      .feishu-drawer-backdrop:hover {
        background: rgba(0, 0, 0, 0.48);
      }
      .feishu-drawer-panel {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        width: 86vw;
        max-width: none;
        height: 100vh;
        min-width: 0;
        border-left: 1px solid var(--line);
        background: var(--panel);
        box-shadow: -18px 0 48px rgba(0, 0, 0, 0.32);
        transform: translateX(100%);
        transition: transform 160ms ease;
      }
      .feishu-session-drawer.open .feishu-drawer-panel {
        transform: translateX(0);
      }
      .feishu-drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
      }
      .feishu-drawer-title {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .feishu-drawer-title h2,
      .feishu-drawer-title .source {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .feishu-drawer-meta {
        padding: 12px 16px;
        border-bottom: 1px solid var(--line);
        background: var(--panel-2);
      }
      .feishu-drawer-body {
        display: grid;
        align-content: start;
        gap: 12px;
        min-height: 0;
        overflow: auto;
        padding: 16px;
      }
      .feishu-chat-thread {
        display: grid;
        gap: 12px;
      }
      .feishu-chat-heading {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .feishu-message-turn {
        display: grid;
        gap: 8px;
        min-width: 0;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel);
      }
      .feishu-turn-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 10px;
        align-items: center;
        color: var(--muted);
        font-size: 11px;
      }
      .feishu-turn-meta code {
        color: var(--text);
      }
      .feishu-chat-bubble {
        display: grid;
        gap: 4px;
        max-width: min(920px, 100%);
        min-width: 0;
        padding: 9px 11px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .feishu-chat-bubble.user {
        justify-self: start;
        border-color: var(--accent);
        background: var(--accent-soft);
      }
      .feishu-chat-bubble.assistant {
        justify-self: stretch;
      }
      .feishu-chat-bubble.error {
        border-color: var(--danger);
        background: var(--danger-soft);
        color: var(--danger);
      }
      .feishu-bubble-label {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
      }
      .feishu-bubble-body {
        display: grid;
        gap: 8px;
      }
      .feishu-bubble-text {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .feishu-fenced-block {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
      }
      .feishu-fenced-label {
        padding: 6px 8px;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
      }
      .feishu-fenced-content {
        max-height: 300px;
        overflow: auto;
        margin: 0;
        padding: 10px;
        font: 12px/1.5 "SFMono-Regular", Consolas, monospace;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .feishu-fenced-markdown {
        display: grid;
        gap: 7px;
        padding: 10px;
      }
      .feishu-md-heading {
        font-weight: 700;
      }
      .feishu-md-list-item,
      .feishu-md-paragraph {
        overflow-wrap: anywhere;
      }
      .feishu-attachment-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .feishu-attachment-pill {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        min-height: 22px;
        padding: 0 7px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
      }
      button.feishu-attachment-pill {
        width: auto;
        height: auto;
        cursor: pointer;
      }
      button.feishu-attachment-pill:hover {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .feishu-file-pill {
        justify-content: flex-start;
        max-width: min(360px, 100%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .feishu-tool-card,
      .feishu-raw-log {
        min-width: 0;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
      }
      .feishu-tool-card.error {
        border-color: var(--danger);
      }
      .feishu-tool-card summary,
      .feishu-raw-log summary {
        cursor: pointer;
        padding: 8px 10px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      .feishu-tool-card-body,
      .feishu-raw-log-body {
        max-height: 220px;
        overflow: auto;
        margin: 0;
        padding: 10px;
        border-top: 1px solid var(--line);
        font: 12px/1.45 "SFMono-Regular", Consolas, monospace;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .feishu-tool-card.error .feishu-tool-card-body {
        color: var(--danger);
      }
      .usage-shell {
        display: grid;
        gap: 18px;
        min-width: 0;
      }
      .usage-filter {
        display: grid;
        grid-template-columns: minmax(520px, 1.6fr) minmax(140px, 180px) minmax(140px, 170px) minmax(140px, 170px) minmax(120px, 150px) auto;
        gap: 12px;
        align-items: end;
        padding-bottom: 14px;
        border-bottom: 1px solid var(--line);
      }
      .usage-filter-group,
      .usage-control {
        display: grid;
        gap: 7px;
        min-width: 0;
      }
      .usage-segmented {
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
        min-width: 0;
      }
      .usage-segmented button,
      .usage-control select,
      .usage-control input {
        height: 34px;
      }
      .usage-segmented button {
        min-width: 64px;
        padding: 0 12px;
        background: transparent;
        color: var(--text);
        border-color: var(--line);
      }
      .usage-segmented button.active {
        background: var(--accent-soft);
        color: var(--accent-strong);
        border-color: var(--accent);
      }
      .usage-control select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        color: var(--text);
        padding: 0 10px;
        font: inherit;
      }
      .usage-summary {
        display: grid;
        grid-template-columns: repeat(6, minmax(120px, 1fr));
        gap: 10px;
      }
      .usage-card,
      .usage-row,
      .usage-event {
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel-2);
        padding: 10px;
      }
      .usage-label,
      .usage-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .usage-value {
        margin-top: 4px;
        font-size: 20px;
        font-weight: 700;
      }
      .usage-main-grid {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
        gap: 12px;
        align-items: stretch;
        min-width: 0;
      }
      .usage-stacked-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
        min-width: 0;
      }
      .usage-block {
        display: grid;
        gap: 8px;
        min-width: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: color-mix(in srgb, var(--panel-2) 58%, transparent);
      }
      .usage-block h3 {
        margin: 0;
        font-size: 13px;
      }
      .usage-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
      }
      .usage-model-filter {
        width: min(220px, 100%);
      }
      .usage-list,
      .usage-recent {
        display: grid;
        gap: 8px;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
      }
      .usage-timeline-wrap {
        position: relative;
        min-width: 0;
      }
      .usage-timeline {
        position: relative;
        height: 360px;
        min-height: 320px;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 12px;
        background: var(--field);
      }
      .usage-timeline-frame {
        position: relative;
        height: 100%;
        min-height: 0;
        min-width: 0;
      }
      .usage-timeline-y-axis {
        position: absolute;
        top: 18px;
        bottom: 36px;
        left: 0;
        width: 58px;
        color: var(--muted);
        font-size: 11px;
      }
      .usage-timeline-axis-top,
      .usage-timeline-axis-zero {
        position: absolute;
        right: 8px;
        white-space: nowrap;
      }
      .usage-timeline-axis-top {
        top: -5px;
      }
      .usage-timeline-axis-zero {
        bottom: -4px;
      }
      .usage-timeline-plot {
        position: absolute;
        top: 18px;
        right: 8px;
        bottom: 36px;
        left: 62px;
        overflow: hidden;
        border-bottom: 1px solid var(--line);
        border-left: 1px solid var(--line);
      }
      .usage-timeline-svg {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
      }
      .usage-timeline-bar-segment {
        shape-rendering: crispEdges;
      }
      .usage-timeline-bar-hit {
        cursor: default;
        outline: none;
      }
      .usage-timeline-bar-hit:focus-visible {
        stroke: var(--accent);
        stroke-width: 0.6;
      }
      .usage-timeline-tooltip {
        position: absolute;
        z-index: 20;
        display: grid;
        gap: 8px;
        width: min(280px, calc(100% - 24px));
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel);
        box-shadow: var(--shadow);
        color: var(--text);
        pointer-events: none;
      }
      .usage-timeline-tooltip[hidden] {
        display: none;
      }
      .usage-tooltip-title {
        font-weight: 700;
      }
      .usage-tooltip-grid,
      .usage-tooltip-providers {
        display: grid;
        gap: 5px;
      }
      .usage-tooltip-row,
      .usage-tooltip-provider {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
      }
      .usage-tooltip-provider-name {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .usage-tooltip-provider-name code {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .usage-timeline-x-axis {
        position: absolute;
        right: 8px;
        bottom: 0;
        left: 62px;
        height: 30px;
      }
      .usage-timeline-label {
        position: absolute;
        bottom: 0;
        transform: translateX(-50%) rotate(-16deg);
        transform-origin: top center;
        overflow: hidden;
        max-width: 78px;
        color: var(--muted);
        font-size: 11px;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .usage-row-main,
      .usage-event-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content;
        align-items: center;
        gap: 10px;
        min-width: 0;
        max-width: 100%;
      }
      .usage-row-name {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .usage-provider-dot {
        width: 9px;
        height: 9px;
        border-radius: 3px;
        flex: 0 0 auto;
      }
      .usage-name {
        display: block;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .usage-bar {
        height: 5px;
        overflow: hidden;
        border-radius: 4px;
        background: var(--line);
      }
      .usage-bar-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--accent);
      }
      .usage-event {
        display: grid;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
      }
      .usage-event-meta {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        color: var(--muted);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .usage-empty {
        color: var(--muted);
        border: 1px dashed var(--line);
        border-radius: 6px;
        padding: 12px;
      }
      @media (max-width: 760px) {
        header {
          padding-left: 14px;
          padding-right: 14px;
        }
        main {
          padding: 16px;
        }
        .config-grid,
        .channels-grid,
        .terminal-toolbar,
        .usage-filter,
        .usage-main-grid,
        .usage-stacked-grid,
        .usage-summary {
          grid-template-columns: 1fr;
        }
        /* Collapse the provider editor to one column on narrow screens. */
        .modal {
          width: min(560px, calc(100vw - 24px));
        }
        .provider-editor-grid {
          grid-template-columns: 1fr;
        }
        .usage-panel-head {
          align-items: stretch;
          flex-direction: column;
        }
        .usage-model-filter {
          width: 100%;
        }
        .feishu-drawer-panel {
          width: 100vw;
        }
        .channel-message-detail-grid {
          grid-template-columns: 1fr;
        }
        .terminal-meta {
          justify-content: flex-start;
        }
        body.chat-active main {
          height: calc(100vh - 58px);
        }
        .row {
          grid-template-columns: 1fr;
        }
        .tabs {
          overflow-x: auto;
        }
        .usage-segmented {
          flex-wrap: wrap;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1 data-i18n="app.title">Claudish Config</h1>
      <div class="header-actions">
        <button class="ghost language-toggle" id="language-toggle" type="button" aria-label="Switch language" title="Switch language">中 / EN</button>
        <button class="ghost theme-toggle" id="theme-toggle" type="button" aria-label="Switch to light theme" title="Switch to light theme" data-target-theme="light">
          <span class="theme-icon" aria-hidden="true"></span>
        </button>
        <div class="source">127.0.0.1</div>
      </div>
    </header>
    <main>
      <nav class="tabs" aria-label="Configuration sections">
        <button class="tab active" data-tab="usage" type="button" data-i18n="tabs.usage">Usage</button>
        <button class="tab" data-tab="config" type="button" data-i18n="tabs.config">Config</button>
        <button class="tab" data-tab="providers" type="button" data-i18n="tabs.providers">Providers</button>
        <button class="tab" data-tab="channels" type="button" data-i18n="tabs.channels">Channels</button>
        <button class="tab" data-tab="chat" type="button" data-i18n="tabs.chat">Chat</button>
      </nav>

      <section class="panel" id="panel-config">
        <div class="config-grid">
          <section>
            <h2 data-i18n="config.defaults">Defaults</h2>
            <form id="defaults-form">
              <label>
                <span data-i18n="config.defaultModel">Default model</span>
                <div class="combo" data-combo="models">
                  <input id="default-model" name="defaultModel" placeholder="gpt-5.5" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show model options" data-i18n-aria-label="aria.showModelOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
              </label>
              <label>
                <span data-i18n="config.defaultProvider">Default provider</span>
                <div class="combo" data-combo="providers">
                  <input id="default-provider" name="defaultProvider" placeholder="openrouter" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show provider options" data-i18n-aria-label="aria.showProviderOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
              </label>
              <button type="submit" data-i18n="config.saveDefaults">Save Defaults</button>
              <div class="source" id="effective-defaults"></div>
            </form>
          </section>
          <section>
            <h2 data-i18n="providers.current">Current Providers</h2>
            <div class="table" id="provider-summary"></div>
          </section>
          <section class="config-channel-summary-section">
            <h2 data-i18n="config.channels">Channels</h2>
            <div class="channel-overview-list" id="config-channel-summary"></div>
          </section>
        </div>
      </section>

      <section class="panel" id="panel-providers">
        <section>
          <div class="section-head">
            <h2 data-i18n="providers.title">Providers</h2>
            <button id="provider-add" type="button" data-i18n="providers.add">Add Provider</button>
          </div>
          <div class="table" id="provider-list"></div>
        </section>
      </section>

      <section class="panel" id="panel-channels">
        <div class="channels-grid">
          <section>
            <div class="section-head">
              <h2 data-i18n="channels.title">Channels</h2>
              <button class="ghost" id="channels-refresh" type="button" data-i18n="channels.refresh">Refresh</button>
            </div>
            <div class="source" id="channels-status" data-i18n="channels.loading">Loading channel status.</div>
            <div class="channel-list" id="channel-list"></div>
          </section>
          <section class="channel-detail" id="channel-detail">
            <div class="feishu-channel-detail" id="channel-feishu-detail">
              <div class="section-head">
                <div>
                  <h2 data-i18n="channels.feishu">Feishu</h2>
                  <div class="source" id="channel-feishu-session-count" data-i18n="channels.loading">Loading channel status.</div>
                </div>
                <div class="feishu-channel-actions">
                  <button class="ghost" id="feishu-edit-all" type="button" data-i18n="feishuConfig.editAll">Edit All</button>
                  <button class="ghost" id="feishu-cancel-all" type="button" data-i18n="common.cancel" hidden>Cancel</button>
                  <button class="ghost" id="feishu-save-all" type="button" data-i18n="feishuConfig.saveAll" hidden>Save All</button>
                  <button class="ghost" id="feishu-account-add" type="button" data-i18n="feishuConfig.add">Add Account</button>
                </div>
              </div>
              <form id="feishu-config-form">
                <div class="source" data-i18n="feishuConfig.help">Only hot-reloadable fields are editable here. Other config comments are preserved.</div>
                <div class="feishu-account-list" id="feishu-account-list"></div>
              </form>
            </div>
            <div id="channel-empty-detail" hidden>
              <h2 data-i18n="channels.title">Channels</h2>
              <div class="source" data-i18n="channels.selectChannel">Select a channel to inspect its accounts and sessions.</div>
            </div>
          </section>
        </div>
      </section>

      <section class="panel" id="panel-chat">
        <section class="terminal-shell">
          <div class="terminal-toolbar" id="terminal-settings">
            <label class="terminal-tool">
              <span class="field-label" data-i18n="terminal.provider">Provider</span>
                <div class="combo" data-combo="providers">
                  <input id="chat-provider" placeholder="openrouter" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show provider options" data-i18n-aria-label="aria.showProviderOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
            </label>
            <label class="terminal-tool">
              <span class="field-label" data-i18n="terminal.model">Model</span>
                <div class="combo" data-combo="models">
                  <input id="chat-model" placeholder="gpt-5.5" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show model options" data-i18n-aria-label="aria.showModelOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
            </label>
            <div class="terminal-actions">
              <button id="terminal-start" type="button" data-i18n="terminal.start">Start Session</button>
              <button class="ghost" id="terminal-stop" type="button" disabled data-i18n="terminal.stop">Stop</button>
            </div>
            <div class="terminal-meta">
              <div class="source" id="terminal-effective"></div>
              <div class="source" id="terminal-status" data-i18n="terminal.disconnected">Disconnected.</div>
            </div>
          </div>
          <div class="terminal-frame" id="terminal-frame">
            <div id="terminal"></div>
          </div>
        </section>
      </section>

      <section class="panel active" id="panel-usage">
        <section class="usage-shell">
          <div class="section-head">
            <h2 data-i18n="usage.title">Usage Dashboard</h2>
            <div class="source" id="usage-range-label"></div>
          </div>
          <div class="usage-filter" id="usage-filter">
            <div class="usage-filter-group">
              <span class="field-label" data-i18n="usage.range">Range</span>
              <div class="usage-segmented" id="usage-preset-buttons">
                <button type="button" data-usage-preset="today" data-i18n="usage.today">Today</button>
                <button type="button" data-usage-preset="week" data-i18n="usage.week">This Week</button>
                <button type="button" data-usage-preset="month" data-i18n="usage.month">This Month</button>
                <button type="button" data-usage-preset="all" data-i18n="usage.all">All</button>
                <button type="button" data-usage-preset="recent" data-i18n="usage.recentRange">Recent</button>
                <button type="button" data-usage-preset="custom" data-i18n="usage.custom">Custom</button>
              </div>
            </div>
            <label class="usage-control">
              <span class="field-label" data-i18n="usage.recentRange">Recent</span>
              <select id="usage-recent-value">
                <option value="1天" data-i18n="usage.recent.oneDay">1 day</option>
                <option value="7天" data-i18n="usage.recent.sevenDays">7 days</option>
                <option value="1个月" data-i18n="usage.recent.oneMonth">1 month</option>
                <option value="3个月" data-i18n="usage.recent.threeMonths">3 months</option>
                <option value="半年" data-i18n="usage.recent.halfYear">6 months</option>
                <option value="一年" data-i18n="usage.recent.oneYear">1 year</option>
              </select>
            </label>
            <label class="usage-control">
              <span class="field-label" data-i18n="usage.start">Start</span>
              <input id="usage-start-date" type="date" />
            </label>
            <label class="usage-control">
              <span class="field-label" data-i18n="usage.end">End</span>
              <input id="usage-end-date" type="date" />
            </label>
            <label class="usage-control">
              <span class="field-label" data-i18n="usage.bucket">Granularity</span>
              <select id="usage-bucket">
                <option value="day" data-i18n="usage.bucket.day">By day</option>
                <option value="week" data-i18n="usage.bucket.week">By week</option>
                <option value="month" data-i18n="usage.bucket.month">By month</option>
              </select>
            </label>
            <button class="ghost" id="usage-refresh" type="button" data-i18n="usage.refresh">Refresh</button>
          </div>
          <div class="usage-summary" id="usage-summary"></div>
          <div class="usage-main-grid">
            <div class="usage-block">
              <div class="usage-panel-head">
                <h3 data-i18n="usage.timeline">Time Distribution</h3>
              </div>
              <div class="usage-timeline-wrap">
                <div class="usage-timeline" id="usage-timeline"></div>
                <div class="usage-timeline-tooltip" id="usage-timeline-tooltip" hidden></div>
              </div>
            </div>
            <div class="usage-block">
              <h3 data-i18n="usage.providerDistribution">Provider Distribution</h3>
              <div class="usage-list" id="usage-providers"></div>
            </div>
          </div>
          <div class="usage-stacked-grid">
            <div class="usage-block">
              <div class="usage-panel-head">
                <h3 data-i18n="usage.modelDistribution">Model Distribution</h3>
                <label class="usage-control usage-model-filter">
                  <span class="field-label" data-i18n="usage.modelProvider">Provider</span>
                  <select id="usage-model-provider"></select>
                </label>
              </div>
              <div class="usage-list" id="usage-models"></div>
            </div>
            <div class="usage-block">
              <h3 data-i18n="usage.projectDirectories">Project Directories</h3>
              <div class="usage-list" id="usage-projects"></div>
            </div>
          </div>
          <div class="usage-block">
            <h3 data-i18n="usage.recent">Recent Requests</h3>
            <div class="usage-recent" id="usage-recent"></div>
          </div>
        </section>
      </section>

      <p id="status"></p>
    </main>
    <div class="feishu-session-drawer" id="feishu-session-drawer" hidden>
      <button class="feishu-drawer-backdrop" id="feishu-session-drawer-backdrop" type="button" aria-label="Close" data-i18n-aria-label="common.close"></button>
      <aside class="feishu-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="feishu-session-drawer-title">
        <div class="feishu-drawer-head">
          <div class="feishu-drawer-title">
            <h2 id="feishu-session-drawer-title" data-i18n="channels.sessionDetails">Details</h2>
            <div class="source" id="feishu-session-drawer-subtitle"></div>
          </div>
          <button class="ghost" id="feishu-session-drawer-close" type="button" data-i18n="common.close">Close</button>
        </div>
        <div class="channel-message-detail-grid feishu-drawer-meta" id="feishu-session-drawer-meta"></div>
        <div class="feishu-drawer-body" id="feishu-session-drawer-body"></div>
      </aside>
    </div>
    <div class="modal-backdrop" id="provider-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="provider-form-title">
        <div class="modal-head">
          <h2 id="provider-form-title" data-i18n="providerModal.title">Custom Provider</h2>
          <button class="ghost" id="provider-close" type="button" aria-label="Close provider editor" data-i18n="common.close" data-i18n-aria-label="aria.closeProviderEditor">Close</button>
        </div>
        <div class="modal-body">
          <form id="provider-form">
            <div class="provider-editor-grid">
              <!-- Provider connection fields stay together so OAuth modes can hide credentials cleanly. -->
              <div class="provider-editor-info">
                <label>
                  <span data-i18n="providerModal.providerId">Provider ID</span>
                  <input id="provider-id" name="providerId" placeholder="corp-openai" required />
                </label>
                <label id="provider-format-field">
                  <span data-i18n="providerModal.compatibleType">Compatible type</span>
                  <div class="combo" data-combo="formats">
                    <input id="provider-format" name="format" value="openai" autocomplete="off" readonly />
                    <button class="combo-toggle" type="button" aria-label="Show compatible types" data-i18n-aria-label="aria.showCompatibleTypes"></button>
                    <div class="combo-menu" role="listbox"></div>
                  </div>
                </label>
                <label id="provider-url-field">
                  <span data-i18n="providerModal.baseUrl">Base URL</span>
                  <input id="provider-url" name="baseUrl" placeholder="https://api.example.com/v1" required />
                </label>
                <label id="provider-key-field">
                  <span data-i18n="providerModal.apiKey">API key</span>
                  <div class="secret-field">
                    <input id="provider-key" name="apiKey" type="password" placeholder="sk-... or &#36;{ENV_VAR}" autocomplete="off" />
                    <button class="secret-toggle" id="provider-key-toggle" type="button" aria-label="Show API key" data-i18n-aria-label="aria.showApiKey"></button>
                  </div>
                </label>
              </div>
              <!-- Model controls live in their own column so long model lists do not crowd credentials. -->
              <div class="provider-editor-models">
                <label>
                  <span data-i18n="providerModal.defaultModel">Default model</span>
                  <div class="combo" data-combo="models">
                    <input id="provider-model" name="defaultModel" placeholder="gpt-4o" autocomplete="off" />
                    <button class="combo-toggle" type="button" aria-label="Show model options" data-i18n-aria-label="aria.showModelOptions"></button>
                    <div class="combo-menu" role="listbox"></div>
                  </div>
                </label>
                <div class="provider-model-editor">
                  <span class="field-label" data-i18n="providerModal.models">Models</span>
                  <div class="provider-model-add-row">
                    <input id="provider-model-input" placeholder="gpt-4o" autocomplete="off" data-i18n-placeholder="providerModal.modelInputPlaceholder" />
                    <button class="ghost model-add-button" id="provider-model-add" type="button" aria-label="Add model" title="Add model" data-i18n-aria-label="aria.addProviderModel" data-i18n-title="providerModal.addModel">+</button>
                  </div>
                  <div class="provider-model-list" id="provider-model-list"></div>
                  <span class="field-help" data-i18n="providerModal.modelsHelp">Add one model at a time. The default model will be saved with the list.</span>
                </div>
              </div>
            </div>
            <div class="modal-actions">
              <button class="ghost" id="provider-login" type="button" data-i18n="providerModal.relogin" hidden>Relogin</button>
              <button class="ghost" id="provider-cancel" type="button" data-i18n="common.cancel">Cancel</button>
              <button type="submit" data-i18n="providerModal.save">Save Provider</button>
            </div>
          </form>
        </div>
      </div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script>
      // Keep browser-side state tiny and derived from the JSON API.
      let currentState = null;
      let usageState = null;
      let channelsState = null;
      let feishuConfigState = { accounts: [] };
      let editingProviderId = "";
      let editingProviderSource = "";
      let expandedProviderId = "";
      let providerModelDraft = [];
      let providerModelTestStates = new Map();
      let selectedChannelId = "feishu";
      let editingFeishuAccountIndexes = new Set();
      let newFeishuAccountIndexes = new Set();
      let hasFeishuDraftChanges = false;
      let terminal = null;
      let terminalFitAddon = null;
      let terminalSocket = null;
      let terminalInputDisposable = null;
      let terminalResizeDisposable = null;
      let channelsRefreshTimer = null;
      let activeFeishuSessionKey = "";
      let currentLanguage = "en";
      let lastEditorState = null;
      const usageFilters = {
        preset: "all",
        recentValue: "1个月",
        startDate: "",
        endDate: "",
        bucket: "day",
        modelProvider: "all",
      };
      // Stable provider palette keeps legend rows and stacked timeline segments aligned.
      const PROVIDER_COLORS = [
        "#22a991",
        "#5b9cff",
        "#f4c76a",
        "#e88cff",
        "#ff8a80",
        "#8ed081",
        "#b38cff",
        "#f59e42",
      ];
      const SVG_NS = "http://www.w3.org/2000/svg";
      const CODEX_OAUTH_TYPE_LABEL = "Codex-Oauth";
      const SECRET_MASK = "••••••••••••••••••••••••";
      const comboStates = new Map();

      // UI translations stay client-side so the config API remains unchanged.
      const translations = {
        en: {
          "app.title": "Claudish Config",
          "tabs.config": "Config",
          "tabs.providers": "Providers",
          "tabs.channels": "Channels",
          "tabs.chat": "Chat",
          "tabs.usage": "Usage",
          "theme.toLight": "Switch to light theme",
          "theme.toDark": "Switch to dark theme",
          "language.toggle": "Switch language",
          "config.defaults": "Defaults",
          "config.defaultModel": "Default model",
          "config.defaultProvider": "Default provider",
          "config.saveDefaults": "Save Defaults",
          "config.effective": "Effective model: {model} ({modelSource}), provider: {provider} ({providerSource})",
          "config.interactiveSelector": "interactive selector",
          "config.channels": "Channels",
          "feishuConfig.title": "Feishu Accounts",
          "feishuConfig.add": "Add Account",
          "feishuConfig.edit": "Edit",
          "feishuConfig.editAll": "Edit All",
          "feishuConfig.saveAccount": "Save",
          "feishuConfig.saveAll": "Save All",
          "feishuConfig.save": "Save Feishu Accounts",
          "feishuConfig.help": "Only hot-reloadable fields are editable here. Other config comments are preserved.",
          "feishuConfig.empty": "No Feishu accounts yet.",
          "feishuConfig.enabled": "Enabled",
          "feishuConfig.progress": "Progress replies",
          "feishuConfig.appSecret": "App Secret",
          "feishuConfig.secretHelp": "Leave blank to keep the saved secret.",
          "feishuConfig.showSecret": "Show App Secret",
          "feishuConfig.hideSecret": "Hide App Secret",
          "feishuConfig.botOpenId": "Bot open_id",
          "feishuConfig.domain": "Domain",
          "feishuConfig.readonly": "Restart-only fields",
          "feishuConfig.remove": "Remove",
          "providers.current": "Current Providers",
          "providers.title": "Providers",
          "providers.add": "Add Provider",
          "providers.id": "ID",
          "providers.type": "Type",
          "providers.modelCount": "Models",
          "providers.defaultModel": "Default model",
          "providers.actions": "Actions",
          "providers.copyCommand": "Copy launch command",
          "providers.copiedCommand": "Copied",
          "providers.edit": "Edit",
          "providers.delete": "Delete",
          "providerModal.title": "Custom Provider",
          "providerModal.editTitle": "Edit Provider: {id}",
          "providerModal.providerId": "Provider ID",
          "providerModal.compatibleType": "Compatible type",
          "providerModal.baseUrl": "Base URL",
          "providerModal.apiKey": "API key",
          "providerModal.defaultModel": "Default model",
          "providerModal.models": "Models",
          "providerModal.modelInputPlaceholder": "model id",
          "providerModal.addModel": "Add model",
          "providerModal.removeModel": "Remove model",
          "providerModal.testModel": "Test",
          "providerModal.testingModel": "Testing...",
          "providerModal.testSuccess": "OK {ms}ms",
          "providerModal.testFailure": "Failed: {message}",
          "providerModal.emptyModels": "No models added yet.",
          "providerModal.modelsHelp": "Add one model at a time. The default model will be saved with the list.",
          "providerModal.relogin": "Relogin",
          "providerModal.save": "Save Provider",
          "providerModal.keepKey": "Leave blank to keep saved key",
          "common.cancel": "Cancel",
          "common.close": "Close",
          "combo.noMatches": "No matches",
          "terminal.provider": "Provider",
          "terminal.model": "Model",
          "terminal.start": "Start Chat",
          "terminal.restart": "Restart Chat",
          "terminal.stop": "Stop",
          "terminal.default": "Default: {provider} / {model}",
          "terminal.disconnected": "Disconnected.",
          "terminal.connecting": "Starting claudish...",
          "terminal.restarting": "Restarting claudish...",
          "terminal.connected": "Connected.",
          "terminal.closed": "Chat session closed.",
          "terminal.unavailable": "Chat terminal library failed to load.",
          "channels.title": "Channels",
          "channels.refresh": "Refresh",
          "channels.feishu": "Feishu",
          "channels.webChat": "Web Chat",
          "channels.loading": "Loading channel status.",
          "channels.none": "No channels configured.",
          "channels.status": "Status",
          "channels.sessions": "Sessions",
          "channels.selectChannel": "Select a channel to inspect its accounts and sessions.",
          "channels.configuredAccounts": "{count} configured",
          "channels.enabledAccounts": "{count} enabled",
          "channels.activeSessions": "{count} active",
          "channels.model": "Model",
          "channels.cwd": "Working directory",
          "channels.messages": "Recent Feishu Messages",
          "channels.sessionMonitor": "Feishu Sessions",
          "channels.sessionCount": "{count} sessions",
          "channels.sessionEmpty": "No handled Feishu sessions yet.",
          "channels.sessionDetails": "Details",
          "channels.sessionDetailsButton": "Open",
          "channels.sessionCurrentMessage": "Current message",
          "channels.sessionMessageCount": "Messages",
          "channels.sessionOutput": "Model output",
          "channels.sessionMessageLog": "Message log",
          "channels.sessionTimeline": "Conversation",
          "channels.sessionRawLog": "Raw log",
          "channels.sessionUser": "User",
          "channels.sessionAssistant": "Assistant",
          "channels.sessionTool": "Tool",
          "channels.sessionToolInput": "Input",
          "channels.sessionToolResult": "Result",
          "channels.sessionToolFailed": "Failed",
          "channels.sessionStderr": "stderr",
          "channels.sessionNoEvents": "No model events yet.",
          "channels.messageCount": "{count} messages",
          "channels.messageEmpty": "No handled Feishu messages yet.",
          "channels.messageAccount": "Account",
          "channels.messageSource": "Source",
          "channels.messageSender": "Sender",
          "channels.messagePreview": "Message",
          "channels.messageImages": "Images",
          "channels.messageFiles": "Files",
          "channels.messageStage": "Stage",
          "channels.messageElapsed": "Elapsed",
          "channels.messageError": "Error",
          "channels.messageDetails": "Error details",
          "channels.messageId": "Message ID",
          "channels.messageConversation": "Conversation",
          "channels.messageReceivedAt": "Received",
          "channels.messageSource.group": "Group",
          "channels.messageSource.direct": "DM",
          "channels.messageStage.received": "Received",
          "channels.messageStage.downloading_images": "Downloading",
          "channels.messageStage.downloading_files": "Downloading files",
          "channels.messageStage.queued": "Queued",
          "channels.messageStage.model_processing": "Model",
          "channels.messageStage.replying": "Replying",
          "channels.messageStage.completed": "Done",
          "channels.messageStage.failed": "Failed",
          "channels.messageStage.stopped": "Stopped",
          "usage.title": "Usage Dashboard",
          "usage.refresh": "Refresh",
          "usage.range": "Range",
          "usage.today": "Today",
          "usage.week": "This Week",
          "usage.month": "This Month",
          "usage.all": "All",
          "usage.recentRange": "Recent",
          "usage.custom": "Custom",
          "usage.start": "Start",
          "usage.end": "End",
          "usage.bucket": "Granularity",
          "usage.bucket.day": "By day",
          "usage.bucket.week": "By week",
          "usage.bucket.month": "By month",
          "usage.recent.oneDay": "1 day",
          "usage.recent.sevenDays": "7 days",
          "usage.recent.oneMonth": "1 month",
          "usage.recent.threeMonths": "3 months",
          "usage.recent.halfYear": "6 months",
          "usage.recent.oneYear": "1 year",
          "usage.requests": "Requests",
          "usage.total": "Total tokens",
          "usage.input": "Input",
          "usage.cached": "Cached",
          "usage.output": "Output",
          "usage.reasoning": "Reasoning",
          "usage.providers": "Providers",
          "usage.models": "Models",
          "usage.projects": "Projects",
          "usage.timeline": "Time Distribution",
          "usage.providerDistribution": "Provider Distribution",
          "usage.modelDistribution": "Model Distribution",
          "usage.modelProvider": "Provider",
          "usage.allProviders": "All providers",
          "usage.projectDirectories": "Project Directories",
          "usage.recent": "Recent Requests",
          "usage.noData": "No usage records yet.",
          "usage.requestCount": "{count} requests",
          "usage.tokenCount": "{count} tokens",
          "usage.rangeLabel": "{start} to {end} · {bucket}",
          "status.defaultsSaved": "Defaults saved.",
          "status.providerDeleted": "Provider deleted.",
          "status.providerUpdated": "Provider updated.",
          "status.providerSaved": "Provider saved.",
          "status.commandCopied": "Launch command copied.",
          "status.oauthLoginStarted": "OAuth login started...",
          "status.oauthLoginDone": "OAuth login completed.",
          "status.feishuConfigSaved": "Feishu accounts saved.",
          "status.terminalStarted": "Chat session started.",
          "status.terminalStopped": "Chat session stopped.",
          "error.terminalStart": "Could not start chat session.",
          "aria.showModelOptions": "Show model options",
          "aria.showProviderOptions": "Show provider options",
          "aria.showCompatibleTypes": "Show compatible types",
          "aria.showApiKey": "Show API key",
          "aria.hideApiKey": "Hide API key",
          "aria.closeProviderEditor": "Close provider editor",
          "aria.addProviderModel": "Add model",
          "aria.removeProviderModel": "Remove model",
          "aria.testProviderModel": "Test model",
        },
        zh: {
          "app.title": "Claudish 配置",
          "tabs.config": "配置",
          "tabs.providers": "Provider",
          "tabs.channels": "频道",
          "tabs.chat": "聊天",
          "tabs.usage": "用量",
          "theme.toLight": "切换到浅色主题",
          "theme.toDark": "切换到深色主题",
          "language.toggle": "切换语言",
          "config.defaults": "默认设置",
          "config.defaultModel": "默认模型",
          "config.defaultProvider": "默认 Provider",
          "config.saveDefaults": "保存默认设置",
          "config.effective": "生效模型：{model}（{modelSource}），Provider：{provider}（{providerSource}）",
          "config.interactiveSelector": "交互选择器",
          "config.channels": "频道",
          "feishuConfig.title": "飞书账号",
          "feishuConfig.add": "添加账号",
          "feishuConfig.edit": "编辑",
          "feishuConfig.editAll": "编辑全部",
          "feishuConfig.saveAccount": "保存",
          "feishuConfig.saveAll": "保存全部",
          "feishuConfig.save": "保存飞书账号",
          "feishuConfig.help": "这里仅编辑支持热更新的字段，其他配置和注释会保留。",
          "feishuConfig.empty": "还没有飞书账号。",
          "feishuConfig.enabled": "启用",
          "feishuConfig.progress": "中间回复",
          "feishuConfig.appSecret": "App Secret",
          "feishuConfig.secretHelp": "留空表示保留已保存的 secret。",
          "feishuConfig.showSecret": "显示 App Secret",
          "feishuConfig.hideSecret": "隐藏 App Secret",
          "feishuConfig.botOpenId": "机器人 open_id",
          "feishuConfig.domain": "域",
          "feishuConfig.readonly": "需重启字段",
          "feishuConfig.remove": "移除",
          "providers.current": "当前 Provider",
          "providers.title": "Provider",
          "providers.add": "添加 Provider",
          "providers.id": "ID",
          "providers.type": "类型",
          "providers.modelCount": "模型数",
          "providers.defaultModel": "默认模型",
          "providers.actions": "操作",
          "providers.copyCommand": "复制启动命令",
          "providers.copiedCommand": "已复制",
          "providers.edit": "编辑",
          "providers.delete": "删除",
          "providerModal.title": "自定义 Provider",
          "providerModal.editTitle": "编辑 Provider：{id}",
          "providerModal.providerId": "Provider ID",
          "providerModal.compatibleType": "兼容类型",
          "providerModal.baseUrl": "Base URL",
          "providerModal.apiKey": "API key",
          "providerModal.defaultModel": "默认模型",
          "providerModal.models": "模型列表",
          "providerModal.modelInputPlaceholder": "模型 ID",
          "providerModal.addModel": "添加模型",
          "providerModal.removeModel": "移除模型",
          "providerModal.testModel": "测试",
          "providerModal.testingModel": "测试中...",
          "providerModal.testSuccess": "成功 {ms}ms",
          "providerModal.testFailure": "失败：{message}",
          "providerModal.emptyModels": "还没有添加模型。",
          "providerModal.modelsHelp": "每次添加一个模型。默认模型会随列表一起保存。",
          "providerModal.relogin": "重新登录",
          "providerModal.save": "保存 Provider",
          "providerModal.keepKey": "留空以保留已保存的 key",
          "common.cancel": "取消",
          "common.close": "关闭",
          "combo.noMatches": "没有匹配项",
          "terminal.provider": "Provider",
          "terminal.model": "模型",
          "terminal.start": "启动聊天",
          "terminal.restart": "重启聊天",
          "terminal.stop": "停止",
          "terminal.default": "默认：{provider} / {model}",
          "terminal.disconnected": "未连接。",
          "terminal.connecting": "正在启动 claudish...",
          "terminal.restarting": "正在重启 claudish...",
          "terminal.connected": "已连接。",
          "terminal.closed": "聊天会话已关闭。",
          "terminal.unavailable": "聊天终端库加载失败。",
          "channels.title": "频道",
          "channels.refresh": "刷新",
          "channels.feishu": "飞书",
          "channels.webChat": "Web Chat",
          "channels.loading": "正在加载频道状态。",
          "channels.none": "还没有配置频道。",
          "channels.status": "状态",
          "channels.sessions": "会话",
          "channels.selectChannel": "选择一个频道查看账号和会话。",
          "channels.configuredAccounts": "配置 {count} 个",
          "channels.enabledAccounts": "启用 {count} 个",
          "channels.activeSessions": "处理中 {count} 个",
          "channels.model": "模型",
          "channels.cwd": "工作目录",
          "channels.messages": "最近飞书消息",
          "channels.sessionMonitor": "飞书会话",
          "channels.sessionCount": "{count} 个会话",
          "channels.sessionEmpty": "还没有进入处理流程的飞书会话。",
          "channels.sessionDetails": "详情",
          "channels.sessionDetailsButton": "打开",
          "channels.sessionCurrentMessage": "当前消息",
          "channels.sessionMessageCount": "消息数",
          "channels.sessionOutput": "模型输出",
          "channels.sessionMessageLog": "消息记录",
          "channels.sessionTimeline": "会话记录",
          "channels.sessionRawLog": "原始日志",
          "channels.sessionUser": "用户",
          "channels.sessionAssistant": "模型",
          "channels.sessionTool": "工具",
          "channels.sessionToolInput": "输入参数",
          "channels.sessionToolResult": "工具结果",
          "channels.sessionToolFailed": "失败",
          "channels.sessionStderr": "stderr",
          "channels.sessionNoEvents": "还没有模型过程。",
          "channels.messageCount": "{count} 条消息",
          "channels.messageEmpty": "还没有进入处理流程的飞书消息。",
          "channels.messageAccount": "账号",
          "channels.messageSource": "来源",
          "channels.messageSender": "发送人",
          "channels.messagePreview": "消息",
          "channels.messageImages": "图片",
          "channels.messageFiles": "文件",
          "channels.messageStage": "阶段",
          "channels.messageElapsed": "耗时",
          "channels.messageError": "错误",
          "channels.messageDetails": "错误详情",
          "channels.messageId": "消息 ID",
          "channels.messageConversation": "会话",
          "channels.messageReceivedAt": "接收时间",
          "channels.messageSource.group": "群聊",
          "channels.messageSource.direct": "私聊",
          "channels.messageStage.received": "已接收",
          "channels.messageStage.downloading_images": "下载图片",
          "channels.messageStage.downloading_files": "下载文件",
          "channels.messageStage.queued": "排队",
          "channels.messageStage.model_processing": "模型处理中",
          "channels.messageStage.replying": "回复中",
          "channels.messageStage.completed": "完成",
          "channels.messageStage.failed": "失败",
          "channels.messageStage.stopped": "已停止",
          "usage.title": "用量看板",
          "usage.refresh": "刷新",
          "usage.range": "范围",
          "usage.today": "今日",
          "usage.week": "本周",
          "usage.month": "本月",
          "usage.all": "全部",
          "usage.recentRange": "最近",
          "usage.custom": "自定义",
          "usage.start": "开始",
          "usage.end": "结束",
          "usage.bucket": "粒度",
          "usage.bucket.day": "按天",
          "usage.bucket.week": "按周",
          "usage.bucket.month": "按月",
          "usage.recent.oneDay": "1 天",
          "usage.recent.sevenDays": "7 天",
          "usage.recent.oneMonth": "1 个月",
          "usage.recent.threeMonths": "3 个月",
          "usage.recent.halfYear": "半年",
          "usage.recent.oneYear": "一年",
          "usage.requests": "请求数",
          "usage.total": "总 tokens",
          "usage.input": "输入",
          "usage.cached": "缓存",
          "usage.output": "输出",
          "usage.reasoning": "推理",
          "usage.providers": "Provider",
          "usage.models": "模型",
          "usage.projects": "项目目录",
          "usage.timeline": "时间分布",
          "usage.providerDistribution": "Provider 分布",
          "usage.modelDistribution": "模型分布",
          "usage.modelProvider": "Provider",
          "usage.allProviders": "全部 Provider",
          "usage.projectDirectories": "项目目录",
          "usage.recent": "最近请求",
          "usage.noData": "还没有用量记录。",
          "usage.requestCount": "{count} 次请求",
          "usage.tokenCount": "{count} tokens",
          "usage.rangeLabel": "{start} 至 {end} · {bucket}",
          "status.defaultsSaved": "默认设置已保存。",
          "status.providerDeleted": "Provider 已删除。",
          "status.providerUpdated": "Provider 已更新。",
          "status.providerSaved": "Provider 已保存。",
          "status.commandCopied": "启动命令已复制。",
          "status.oauthLoginStarted": "正在启动 OAuth 登录...",
          "status.oauthLoginDone": "OAuth 登录完成。",
          "status.feishuConfigSaved": "飞书账号已保存。",
          "status.terminalStarted": "聊天会话已启动。",
          "status.terminalStopped": "聊天会话已停止。",
          "error.terminalStart": "无法启动聊天会话。",
          "aria.showModelOptions": "显示模型选项",
          "aria.showProviderOptions": "显示 Provider 选项",
          "aria.showCompatibleTypes": "显示兼容类型",
          "aria.showApiKey": "显示 API key",
          "aria.hideApiKey": "隐藏 API key",
          "aria.closeProviderEditor": "关闭 Provider 编辑器",
          "aria.addProviderModel": "添加模型",
          "aria.removeProviderModel": "移除模型",
          "aria.testProviderModel": "测试模型",
        },
      };

      // Cache DOM nodes once because the static shell never re-renders.
      const statusEl = document.querySelector("#status");
      const languageToggleEl = document.querySelector("#language-toggle");
      const themeToggleEl = document.querySelector("#theme-toggle");
      const defaultModelEl = document.querySelector("#default-model");
      const defaultProviderEl = document.querySelector("#default-provider");
      const providerForm = document.querySelector("#provider-form");
      const providerTitle = document.querySelector("#provider-form-title");
      const providerModal = document.querySelector("#provider-modal");
      const providerAddButton = document.querySelector("#provider-add");
      const providerCloseButton = document.querySelector("#provider-close");
      const providerCancelButton = document.querySelector("#provider-cancel");
      const providerIdEl = document.querySelector("#provider-id");
      const providerFormatEl = document.querySelector("#provider-format");
      const providerFormatCombo = document.querySelector("[data-combo='formats']");
      const providerFormatToggle = providerFormatCombo.querySelector(".combo-toggle");
      const providerUrlField = document.querySelector("#provider-url-field");
      const providerUrlEl = document.querySelector("#provider-url");
      const providerKeyField = document.querySelector("#provider-key-field");
      const providerKeyEl = document.querySelector("#provider-key");
      const providerKeyToggle = document.querySelector("#provider-key-toggle");
      const providerLoginButton = document.querySelector("#provider-login");
      const providerDefaultModelEl = document.querySelector("#provider-model");
      const providerModelInputEl = document.querySelector("#provider-model-input");
      const providerModelAddButton = document.querySelector("#provider-model-add");
      const providerModelListEl = document.querySelector("#provider-model-list");
      const configChannelSummaryEl = document.querySelector("#config-channel-summary");
      const feishuConfigFormEl = document.querySelector("#feishu-config-form");
      const feishuAccountListEl = document.querySelector("#feishu-account-list");
      const feishuAccountAddEl = document.querySelector("#feishu-account-add");
      const feishuEditAllEl = document.querySelector("#feishu-edit-all");
      const feishuCancelAllEl = document.querySelector("#feishu-cancel-all");
      const feishuSaveAllEl = document.querySelector("#feishu-save-all");
      const chatProviderEl = document.querySelector("#chat-provider");
      const chatModelEl = document.querySelector("#chat-model");
      const terminalStartEl = document.querySelector("#terminal-start");
      const terminalStopEl = document.querySelector("#terminal-stop");
      const terminalStatusEl = document.querySelector("#terminal-status");
      const terminalMountEl = document.querySelector("#terminal");
      const channelsRefreshEl = document.querySelector("#channels-refresh");
      const channelsStatusEl = document.querySelector("#channels-status");
      const channelListEl = document.querySelector("#channel-list");
      const channelDetailEl = document.querySelector("#channel-detail");
      const channelFeishuDetailEl = document.querySelector("#channel-feishu-detail");
      const channelEmptyDetailEl = document.querySelector("#channel-empty-detail");
      const channelFeishuSessionCountEl = document.querySelector("#channel-feishu-session-count");
      const feishuSessionDrawerEl = document.querySelector("#feishu-session-drawer");
      const feishuSessionDrawerBackdropEl = document.querySelector("#feishu-session-drawer-backdrop");
      const feishuSessionDrawerCloseEl = document.querySelector("#feishu-session-drawer-close");
      const feishuSessionDrawerTitleEl = document.querySelector("#feishu-session-drawer-title");
      const feishuSessionDrawerSubtitleEl = document.querySelector("#feishu-session-drawer-subtitle");
      const feishuSessionDrawerMetaEl = document.querySelector("#feishu-session-drawer-meta");
      const feishuSessionDrawerBodyEl = document.querySelector("#feishu-session-drawer-body");
      const usageRefreshEl = document.querySelector("#usage-refresh");
      const usagePresetButtonsEl = document.querySelector("#usage-preset-buttons");
      const usageRecentValueEl = document.querySelector("#usage-recent-value");
      const usageStartDateEl = document.querySelector("#usage-start-date");
      const usageEndDateEl = document.querySelector("#usage-end-date");
      const usageBucketEl = document.querySelector("#usage-bucket");
      const usageRangeLabelEl = document.querySelector("#usage-range-label");
      const usageSummaryEl = document.querySelector("#usage-summary");
      const usageTimelineEl = document.querySelector("#usage-timeline");
      const usageTimelineTooltipEl = document.querySelector("#usage-timeline-tooltip");
      const usageProvidersEl = document.querySelector("#usage-providers");
      const usageModelProviderEl = document.querySelector("#usage-model-provider");
      const usageModelsEl = document.querySelector("#usage-models");
      const usageProjectsEl = document.querySelector("#usage-projects");
      const usageRecentEl = document.querySelector("#usage-recent");

      // Use fetch for JSON endpoints and surface server validation errors.
      async function requestJson(path, options) {
        const response = await fetch(path, {
          headers: { "content-type": "application/json" },
          ...options,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed");
        return data;
      }

      // Resolve one translation key with English fallback for missing entries.
      function t(key, values = {}) {
        const dictionary = translations[currentLanguage] || translations.en;
        const template = dictionary[key] || translations.en[key] || key;
        return template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
      }

      // Pick the persisted language first, then browser language, then English.
      function detectInitialLanguage() {
        const saved = localStorage.getItem("claudish-language");
        if (saved === "zh" || saved === "en") return saved;
        return navigator.language && navigator.language.toLowerCase().startsWith("zh")
          ? "zh"
          : "en";
      }

      // Apply translated text, placeholders, labels, and dynamic sections.
      function applyLanguage(language) {
        currentLanguage = language === "zh" ? "zh" : "en";
        document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
        document.title = t("app.title");
        localStorage.setItem("claudish-language", currentLanguage);

        for (const element of document.querySelectorAll("[data-i18n]")) {
          element.textContent = t(element.dataset.i18n);
        }
        for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
          element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
        }
        for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
          element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
        }
        for (const element of document.querySelectorAll("[data-i18n-title]")) {
          element.setAttribute("title", t(element.dataset.i18nTitle));
        }

        updateLanguageButton();
        updateThemeButton(document.documentElement.dataset.theme || "dark");
        updateProviderModalTitle();
        renderProviderModelList();
        renderFeishuConfig(feishuConfigState);
        renderEffectiveDefaults(lastEditorState);
        renderTerminalStatus(terminalSocket ? "connected" : "disconnected");
        if (usageState) renderUsageDashboard(usageState);
        if (channelsState) renderChannels(channelsState);
        if (lastEditorState) {
          renderProviders("#provider-summary", lastEditorState.customProviders, false);
          renderProviders("#provider-list", lastEditorState.customProviders, true);
        }
      }

      // Keep the language toggle label pointed at the alternate language.
      function updateLanguageButton() {
        const label = t("language.toggle");
        languageToggleEl.textContent = currentLanguage === "zh" ? "EN" : "中";
        languageToggleEl.setAttribute("aria-label", label);
        languageToggleEl.setAttribute("title", label);
      }

      // Flip between Chinese and English UI text.
      function toggleLanguage() {
        applyLanguage(currentLanguage === "zh" ? "en" : "zh");
      }

      // Write short status updates without adding layout movement.
      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.style.color = isError ? "var(--danger)" : "var(--accent)";
      }

      // Render terminal connection state in the compact toolbar.
      function renderTerminalStatus(state) {
        const keyByState = {
          disconnected: "terminal.disconnected",
          connecting: "terminal.connecting",
          restarting: "terminal.restarting",
          connected: "terminal.connected",
          closed: "terminal.closed",
          unavailable: "terminal.unavailable",
        };
        terminalStatusEl.textContent = t(keyByState[state] || "terminal.disconnected");
        terminalStartEl.textContent = terminalSocket ? t("terminal.restart") : t("terminal.start");
      }

      // Activate one top-level panel at a time.
      function setActiveTab(tabName) {
        for (const button of document.querySelectorAll(".tab")) {
          button.classList.toggle("active", button.dataset.tab === tabName);
        }
        for (const panel of document.querySelectorAll(".panel")) {
          panel.classList.toggle("active", panel.id === "panel-" + tabName);
        }
        document.body.classList.toggle("chat-active", tabName === "chat");
        syncChannelsPolling(tabName);
        if (tabName === "chat") fitTerminalSoon();
        if (tabName === "usage" && !usageState) {
          loadUsageDashboard().catch((err) => setStatus(err.message, true));
        }
        if (tabName === "channels" && !channelsState) {
          loadChannels().catch((err) => setStatus(err.message, true));
        }
      }

      // 只在 Channels 页面打开时轮询，避免其他页面产生不必要请求。
      function syncChannelsPolling(tabName) {
        if (channelsRefreshTimer) {
          clearInterval(channelsRefreshTimer);
          channelsRefreshTimer = null;
        }
        if (tabName !== "channels") return;
        channelsRefreshTimer = setInterval(() => {
          loadChannels().catch((err) => setStatus(err.message, true));
        }, 2000);
      }

      // Apply the persisted theme, or fall back to the browser preference.
      function applyTheme(theme) {
        if (theme) {
          document.documentElement.dataset.theme = theme;
          localStorage.setItem("claudish-theme", theme);
        } else {
          document.documentElement.removeAttribute("data-theme");
          localStorage.removeItem("claudish-theme");
        }
        updateThemeButton(theme);
      }

      // Keep the icon and accessible label aligned with the next theme action.
      function updateThemeButton(theme) {
        const currentTheme =
          theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const targetTheme = currentTheme === "dark" ? "light" : "dark";
        const label = targetTheme === "light" ? t("theme.toLight") : t("theme.toDark");
        themeToggleEl.dataset.targetTheme = targetTheme;
        themeToggleEl.setAttribute("aria-label", label);
        themeToggleEl.setAttribute("title", label);
      }

      // Flip between explicit light and dark themes.
      function toggleTheme() {
        const current = document.documentElement.dataset.theme || "dark";
        applyTheme(current === "dark" ? "light" : "dark");
      }

      // Attach the reusable dark combobox behavior to every .combo wrapper.
      function initializeComboboxes() {
        for (const combo of document.querySelectorAll(".combo")) {
          const input = combo.querySelector("input");
          const menu = combo.querySelector(".combo-menu");
          const toggle = combo.querySelector(".combo-toggle");
          const state = {
            combo,
            input,
            menu,
            kind: combo.dataset.combo,
            options: [],
            activeIndex: -1,
            open: false,
            filterOnInput: false,
          };
          comboStates.set(input.id, state);
          input.addEventListener("focus", () => openCombo(state));
          input.addEventListener("click", () => openCombo(state));
          input.addEventListener("input", () => {
            state.filterOnInput = true;
            renderComboOptions(state);
          });
          input.addEventListener("keydown", (event) => handleComboKeydown(event, state));
          toggle.addEventListener("click", () => {
            state.open ? closeCombo(state) : openCombo(state);
            input.focus();
          });
        }
      }

      // Replace the options for every combobox of a given kind.
      function updateComboOptions(kind, values) {
        for (const state of comboStates.values()) {
          if (state.kind === kind) {
            state.options = values || [];
            if (state.open) renderComboOptions(state);
          }
        }
      }

      // Replace the options for one combobox input without affecting siblings.
      function updateComboOptionsForInput(input, values) {
        const state = comboStates.get(input.id);
        if (!state) return;
        state.options = values || [];
        if (state.open) renderComboOptions(state);
      }

      // Flatten provider-scoped models for free-form provider editor inputs.
      function allBareModelOptions() {
        const options = new Set();
        const grouped = currentState?.modelOptionsByProvider || {};
        for (const models of Object.values(grouped)) {
          for (const model of models) options.add(model);
        }
        return options.size > 0 ? [...options] : currentState?.modelOptions || [];
      }

      // Resolve the bare model list for the currently selected provider.
      function modelOptionsForProvider(provider) {
        const key = provider.trim();
        const grouped = currentState?.modelOptionsByProvider || {};
        return key && grouped[key]?.length ? grouped[key] : allBareModelOptions();
      }

      // Keep paired provider/model fields scoped without changing typed values.
      function refreshModelCombosForProvider() {
        updateComboOptionsForInput(defaultModelEl, modelOptionsForProvider(defaultProviderEl.value));
        updateComboOptionsForInput(chatModelEl, modelOptionsForProvider(chatProviderEl.value));
      }

      // Open one combobox and close all siblings.
      function openCombo(state) {
        if (state.combo.classList.contains("locked")) return;
        closeAllCombos(state.input.id);
        state.open = true;
        state.filterOnInput = false;
        state.combo.classList.add("open");
        renderComboOptions(state);
      }

      // Close a single combobox.
      function closeCombo(state) {
        state.open = false;
        state.activeIndex = -1;
        state.combo.classList.remove("open");
      }

      // Close all comboboxes except an optional active input.
      function closeAllCombos(exceptInputId = "") {
        for (const [inputId, state] of comboStates.entries()) {
          if (inputId !== exceptInputId) closeCombo(state);
        }
      }

      // Render filtered options for one combobox.
      function renderComboOptions(state) {
        const query = state.filterOnInput ? state.input.value.trim().toLowerCase() : "";
        const matches = state.options
          .filter((value) => value.toLowerCase().includes(query))
          .slice(0, 10);
        state.menu.replaceChildren();

        if (matches.length === 0) {
          const empty = document.createElement("div");
          empty.className = "combo-empty";
          empty.textContent = t("combo.noMatches");
          state.menu.appendChild(empty);
          return;
        }

        state.activeIndex = Math.min(Math.max(state.activeIndex, 0), matches.length - 1);
        matches.forEach((value, index) => {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "combo-option" + (index === state.activeIndex ? " active" : "");
          option.textContent = value;
          option.addEventListener("click", () => selectComboOption(state, value));
          state.menu.appendChild(option);
        });
      }

      // Handle keyboard navigation inside a combobox.
      function handleComboKeydown(event, state) {
        if (event.key === "Escape") {
          closeCombo(state);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") {
          return;
        }

        if (!state.open) openCombo(state);
        const options = Array.from(state.menu.querySelectorAll(".combo-option"));
        if (options.length === 0) return;

        event.preventDefault();
        if (event.key === "ArrowDown") {
          state.activeIndex = (state.activeIndex + 1) % options.length;
          renderComboOptions(state);
        } else if (event.key === "ArrowUp") {
          state.activeIndex = (state.activeIndex - 1 + options.length) % options.length;
          renderComboOptions(state);
        } else {
          selectComboOption(state, options[state.activeIndex]?.textContent || options[0].textContent);
        }
      }

      // Commit one option value into its input.
      function selectComboOption(state, value) {
        applyComboValue(state.input, value || "");
        state.filterOnInput = false;
        closeCombo(state);
      }

      // Apply model choices with provider@model split semantics where needed.
      function applyComboValue(input, value) {
        const split = splitProviderModelValue(value);
        if (!split) {
          input.value = value;
          if (input === defaultProviderEl || input === chatProviderEl) {
            refreshModelCombosForProvider();
          }
          return;
        }

        input.value = split.model;
        if (input === defaultModelEl) {
          defaultProviderEl.value = split.provider;
          refreshModelCombosForProvider();
        } else if (input === chatModelEl) {
          chatProviderEl.value = split.provider;
          refreshModelCombosForProvider();
        }
      }

      // Split the first provider@model delimiter while preserving provider shortcuts.
      function splitProviderModelValue(value) {
        const atIndex = value.indexOf("@");
        if (atIndex <= 0 || atIndex === value.length - 1) return null;
        return {
          provider: value.slice(0, atIndex).trim(),
          model: value.slice(atIndex + 1).trim(),
        };
      }

      // Normalize model values so pasted provider@model shortcuts only save the model id.
      function normalizeProviderModelValue(value) {
        const model = String(value || "").trim();
        return splitProviderModelValue(model)?.model || model;
      }

      // Replace the editable model draft while preserving first-seen order.
      function setProviderModelDraft(models) {
        const unique = new Set();
        for (const model of models || []) {
          const normalized = normalizeProviderModelValue(model);
          if (normalized) unique.add(normalized);
        }
        providerModelDraft = [...unique];
        providerModelTestStates = new Map();
        renderProviderModelList();
      }

      // Add one model from the input field and keep the editor ready for the next model.
      function addProviderModel(value = providerModelInputEl.value) {
        const model = normalizeProviderModelValue(value);
        if (!model) {
          renderProviderModelList();
          return;
        }
        if (!providerModelDraft.includes(model)) providerModelDraft.push(model);
        providerModelInputEl.value = "";
        renderProviderModelList();
        providerModelInputEl.focus();
      }

      // Remove one model row and move the default model to a remaining value if needed.
      function removeProviderModel(model) {
        providerModelDraft = providerModelDraft.filter((item) => item !== model);
        providerModelTestStates.delete(model);
        if (providerDefaultModelEl.value === model) {
          providerDefaultModelEl.value = providerModelDraft[0] || "";
        }
        renderProviderModelList();
      }

      // Include the selected default model when serializing the provider model list.
      function collectProviderModels(defaultModel) {
        const models = new Set(providerModelDraft);
        const normalizedDefault = normalizeProviderModelValue(defaultModel);
        if (normalizedDefault) models.add(normalizedDefault);
        return [...models];
      }

      // Render the provider model rows and keep the default-model combobox in sync.
      function renderProviderModelList() {
        providerModelListEl.replaceChildren();
        providerModelAddButton.disabled = !normalizeProviderModelValue(providerModelInputEl.value);
        if (providerModelDraft.length === 0) {
          const empty = document.createElement("div");
          empty.className = "provider-model-empty";
          empty.textContent = t("providerModal.emptyModels");
          providerModelListEl.appendChild(empty);
        } else {
          for (const model of providerModelDraft) {
            providerModelListEl.appendChild(createProviderModelRow(model));
          }
        }
        syncProviderEditorModelOptions();
      }

      // Build one removable model row without injecting user-supplied HTML.
      function createProviderModelRow(model) {
        const row = document.createElement("div");
        row.className = "provider-model-row";
        const code = document.createElement("code");
        code.textContent = model;
        code.title = model;
        const status = document.createElement("span");
        status.className = "provider-model-test-status";
        renderProviderModelTestStatus(status, model);
        const actions = document.createElement("div");
        actions.className = "provider-model-actions";
        const test = document.createElement("button");
        test.type = "button";
        test.className = "ghost provider-model-test";
        test.textContent = t("providerModal.testModel");
        test.disabled = providerModelTestStates.get(model)?.state === "testing";
        test.setAttribute("aria-label", t("aria.testProviderModel") + ": " + model);
        test.setAttribute("title", t("providerModal.testModel"));
        test.addEventListener("click", () => testProviderModel(model));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost provider-model-remove";
        remove.textContent = "x";
        remove.setAttribute("aria-label", t("aria.removeProviderModel") + ": " + model);
        remove.setAttribute("title", t("providerModal.removeModel"));
        remove.addEventListener("click", () => removeProviderModel(model));
        actions.append(test, remove);
        row.append(code, status, actions);
        return row;
      }

      // Render the last connectivity test result for a single model row.
      function renderProviderModelTestStatus(status, model) {
        const result = providerModelTestStates.get(model);
        status.classList.remove("ok", "error");
        if (!result) {
          status.textContent = "";
        } else if (result.state === "testing") {
          status.textContent = t("providerModal.testingModel");
        } else if (result.state === "ok") {
          status.classList.add("ok");
          status.textContent = t("providerModal.testSuccess", { ms: result.latencyMs });
        } else {
          status.classList.add("error");
          status.textContent = t("providerModal.testFailure", { message: result.message });
          status.title = result.message;
        }
      }

      // Send a tiny real probe for the provider/model pair without saving the form.
      async function testProviderModel(model) {
        const providerId = providerIdEl.value.trim() || editingProviderId;
        if (!providerId || !model) {
          providerModelTestStates.set(model, {
            state: "error",
            message: "Missing provider or model",
          });
          renderProviderModelList();
          return;
        }

        providerModelTestStates.set(model, { state: "testing" });
        renderProviderModelList();
        try {
          const result = await requestJson("/api/provider-test", {
            method: "POST",
            body: JSON.stringify({
              provider: providerId,
              model,
              providerConfig: normalizedProviderPayload(providerForm),
            }),
          });
          providerModelTestStates.set(
            model,
            result.ok
              ? { state: "ok", latencyMs: result.latencyMs ?? 0 }
              : { state: "error", message: result.error || "Test failed" }
          );
        } catch (err) {
          providerModelTestStates.set(model, {
            state: "error",
            message: err.message || String(err),
          });
        }
        renderProviderModelList();
      }

      // Let the default-model dropdown prefer the provider's own model list.
      function syncProviderEditorModelOptions() {
        const providerModels = collectProviderModels(providerDefaultModelEl.value);
        updateComboOptionsForInput(
          providerDefaultModelEl,
          providerModels.length > 0 ? providerModels : allBareModelOptions()
        );
      }

      // Render provider rows into either summary or editable table.
      function renderProviders(target, providers, editable) {
        const list = document.querySelector(target);
        list.replaceChildren();
        list.appendChild(createProviderHeader(editable));
        for (const provider of providers) {
          list.appendChild(createProviderRow(provider, editable));
          if (expandedProviderId === provider.id) {
            list.appendChild(createProviderModelsDetailRow(provider));
          }
        }
        for (const button of list.querySelectorAll("button[data-action='toggle-models']")) {
          button.addEventListener("click", () => {
            toggleProviderModels(button.dataset.id);
          });
        }
        for (const button of list.querySelectorAll("button[data-action='copy-command']")) {
          button.addEventListener("click", () => {
            copyProviderCommand(button);
          });
        }
        for (const button of list.querySelectorAll("button[data-action='delete']")) {
          button.addEventListener("click", async () => {
            try {
              await requestJson("/api/custom-providers/" + encodeURIComponent(button.dataset.id), {
                method: "DELETE",
              });
              setStatus(t("status.providerDeleted"));
              await loadState();
            } catch (err) {
              setStatus(err.message, true);
            }
          });
        }
        for (const button of list.querySelectorAll("button[data-action='edit']")) {
          button.addEventListener("click", () => {
            const provider = currentState.customProviders.find((item) => item.id === button.dataset.id);
            if (provider) editProvider(provider);
          });
        }
      }

      // Build the provider table header with text nodes to avoid HTML injection.
      function createProviderHeader(editable) {
        const row = document.createElement("div");
        row.className = "row head";
        for (const label of [
          t("providers.id"),
          t("providers.type"),
          t("providers.modelCount"),
          t("providers.defaultModel"),
          editable ? t("providers.actions") : "",
        ]) {
          const cell = document.createElement("span");
          cell.textContent = label;
          row.appendChild(cell);
        }
        return row;
      }

      // Build one provider row with optional edit/delete actions.
      function createProviderRow(provider, editable) {
        const row = document.createElement("div");
        row.className = "row";
        const type =
          provider.typeLabel ||
          (provider.kind === "simple" ? provider.format : provider.transport || provider.kind);
        row.appendChild(codeCell(provider.id));
        row.appendChild(textCell(type || "-"));
        row.appendChild(providerModelCountButton(provider));
        row.appendChild(codeCell(provider.defaultModel || "-"));
        row.appendChild(editable ? providerActions(provider) : textCell(""));
        return row;
      }

      // Show provider capacity without implying one provider maps to one model.
      function providerModelCount(provider) {
        const count = providerModelList(provider).length;
        return currentLanguage === "zh" ? count + " 个模型" : count + " models";
      }

      // Render the model-count cell as a disclosure control for model commands.
      function providerModelCountButton(provider) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost provider-model-toggle";
        button.dataset.action = "toggle-models";
        button.dataset.id = provider.id;
        button.disabled = providerModelList(provider).length === 0;
        button.classList.toggle("expanded", expandedProviderId === provider.id);
        button.setAttribute("aria-expanded", String(expandedProviderId === provider.id));
        button.textContent = providerModelCount(provider);
        return button;
      }

      // Keep one provider model detail open so the table stays easy to scan.
      function toggleProviderModels(providerId) {
        expandedProviderId = expandedProviderId === providerId ? "" : providerId;
        renderProviders("#provider-summary", lastEditorState.customProviders, false);
        renderProviders("#provider-list", lastEditorState.customProviders, true);
      }

      // Build the expanded model command panel under a provider row.
      function createProviderModelsDetailRow(provider) {
        const detail = document.createElement("div");
        detail.className = "provider-model-detail";
        for (const model of providerModelList(provider)) {
          detail.appendChild(createProviderModelCommandRow(provider, model));
        }
        return detail;
      }

      // Build a single model row with its exact claudish launch command.
      function createProviderModelCommandRow(provider, model) {
        const row = document.createElement("div");
        row.className = "provider-model-command-row";
        const modelCode = codeCell(model);
        modelCode.title = model;
        const command = providerModelCommand(provider.id, model);
        const commandCode = codeCell(command);
        commandCode.className = "provider-model-command";
        commandCode.title = command;
        const copy = providerCommandCopyButton(command);
        row.append(modelCode, commandCode, copy);
        return row;
      }

      // Prefer explicit models, falling back to the default model for legacy config.
      function providerModelList(provider) {
        const models = provider.models?.length ? provider.models : [provider.defaultModel];
        return Array.from(new Set(models.filter(Boolean)));
      }

      // Generate the command users can paste into a terminal.
      function providerModelCommand(providerId, model) {
        return "claudish --model " + providerId + "@" + model;
      }

      // Render a compact icon-only copy button with accessible text.
      function providerCommandCopyButton(command) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost copy-command-button";
        button.dataset.action = "copy-command";
        button.dataset.command = command;
        button.setAttribute("aria-label", t("providers.copyCommand") + ": " + command);
        button.setAttribute("title", t("providers.copyCommand"));
        const text = document.createElement("span");
        text.className = "sr-only";
        text.textContent = t("providers.copyCommand");
        button.appendChild(text);
        return button;
      }

      // Copy a generated command and show a short non-layout-shifting result.
      async function copyProviderCommand(button) {
        const command = button.dataset.command || "";
        if (!command) return;
        await writeClipboardText(command);
        button.classList.add("copied");
        button.setAttribute("title", t("providers.copiedCommand"));
        const label = button.querySelector(".sr-only");
        if (label) label.textContent = t("providers.copiedCommand");
        setStatus(t("status.commandCopied"));
        window.setTimeout(() => {
          button.classList.remove("copied");
          button.setAttribute("title", t("providers.copyCommand"));
          if (label) label.textContent = t("providers.copyCommand");
        }, 1400);
      }

      // Use the browser clipboard API, with an execCommand fallback for older WebViews.
      async function writeClipboardText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      // Render monospace table cells for ids and model names.
      function codeCell(value) {
        const code = document.createElement("code");
        code.textContent = value;
        return code;
      }

      // Render normal table cells for plain labels.
      function textCell(value) {
        const span = document.createElement("span");
        span.textContent = value;
        return span;
      }

      // Render action buttons for simple custom providers.
      function providerActions(provider) {
        const wrap = document.createElement("div");
        wrap.className = "button-row";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "ghost";
        edit.dataset.action = "edit";
        edit.dataset.id = provider.id;
        edit.textContent = t("providers.edit");
        edit.disabled = provider.kind !== "simple";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "secondary";
        del.dataset.action = "delete";
        del.dataset.id = provider.id;
        del.textContent = t("providers.delete");
        wrap.append(edit, del);
        return wrap;
      }

      // Populate the provider form for editing a simple provider.
      function editProvider(provider) {
        editingProviderId = provider.id;
        editingProviderSource = provider.source || "custom";
        updateProviderModalTitle();
        providerIdEl.value = provider.id;
        providerFormatEl.value =
          provider.typeLabel ||
          (provider.authMode === "oauth" ? CODEX_OAUTH_TYPE_LABEL : provider.format || "openai");
        providerUrlEl.value = provider.baseUrl || "";
        resetProviderKeyVisibility();
        applyMaskedProviderKey(provider);
        providerDefaultModelEl.value = provider.defaultModel || "";
        setProviderModelDraft(provider.models?.length ? provider.models : [provider.defaultModel]);
        applyProviderModalMode(provider);
        openProviderModal();
      }

      // Reset the provider form back to create mode.
      function resetProviderForm() {
        editingProviderId = "";
        editingProviderSource = "";
        updateProviderModalTitle();
        providerForm.reset();
        providerFormatEl.value = "openai";
        providerUrlEl.value = "";
        providerModelInputEl.value = "";
        setProviderModelDraft([]);
        applyProviderModalMode(null);
        resetProviderKeyVisibility();
        providerKeyEl.value = "";
        providerKeyEl.placeholder = "sk-... or $" + "{ENV_VAR}";
      }

      // Show a stable password-style mask for saved keys without exposing the secret.
      function applyMaskedProviderKey(provider) {
        if (provider?.apiKey) {
          providerKeyEl.value = SECRET_MASK;
          providerKeyEl.dataset.masked = "true";
          providerKeyEl.placeholder = "";
        } else {
          providerKeyEl.value = "";
          delete providerKeyEl.dataset.masked;
          providerKeyEl.placeholder = t("providerModal.keepKey");
        }
      }

      // Treat the synthetic mask as "keep existing key" when saving.
      function isProviderKeyMasked() {
        return providerKeyEl.dataset.masked === "true" && providerKeyEl.value === SECRET_MASK;
      }

      // Convert the provider form to an API payload without sending the mask string.
      function normalizedProviderPayload(form) {
        const payload = Object.fromEntries(new FormData(form));
        if (isProviderKeyMasked()) payload.apiKey = "";
        return payload;
      }

      // Switch the provider modal between custom, builtin, and OAuth-only modes.
      function applyProviderModalMode(provider) {
        const isBuiltin = provider?.source === "builtin";
        const isOAuth = provider?.authMode === "oauth";
        providerIdEl.readOnly = isBuiltin;
        providerFormatCombo.classList.toggle("locked", isBuiltin);
        providerFormatToggle.disabled = isBuiltin;
        providerUrlField.hidden = Boolean(isOAuth);
        providerKeyField.hidden = Boolean(isOAuth);
        providerUrlEl.required = !isOAuth;
        providerKeyEl.disabled = Boolean(isOAuth);
        providerKeyToggle.disabled = Boolean(isOAuth);
        providerLoginButton.hidden = !isOAuth;
      }

      // Re-apply the localized modal title without changing create/edit mode.
      function updateProviderModalTitle() {
        providerTitle.textContent = editingProviderId
          ? t("providerModal.editTitle", { id: editingProviderId })
          : t("providerModal.title");
      }

      // Restore the secret input to the safe hidden state.
      function resetProviderKeyVisibility() {
        providerKeyEl.type = "password";
        providerKeyToggle.classList.remove("revealed");
        providerKeyToggle.setAttribute("aria-label", t("aria.showApiKey"));
      }

      // Reveal or hide the provider key, fetching saved keys only on demand.
      async function toggleProviderKeyVisibility() {
        const shouldReveal = providerKeyEl.type === "password";
        if (!shouldReveal) {
          resetProviderKeyVisibility();
          return;
        }

        try {
          if (editingProviderId && (!providerKeyEl.value || isProviderKeyMasked())) {
            const secret = await requestJson(
              "/api/custom-providers/" + encodeURIComponent(editingProviderId) + "/secret"
            );
            providerKeyEl.value = secret.apiKey || "";
            delete providerKeyEl.dataset.masked;
          }
          providerKeyEl.type = "text";
          providerKeyToggle.classList.add("revealed");
          providerKeyToggle.setAttribute("aria-label", t("aria.hideApiKey"));
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      // Start the OAuth login flow for the currently edited builtin provider.
      async function loginBuiltinProvider() {
        if (!editingProviderId) return;
        providerLoginButton.disabled = true;
        setStatus(t("status.oauthLoginStarted"));
        try {
          const result = await requestJson(
            "/api/oauth-login/" + encodeURIComponent(editingProviderId),
            { method: "POST" }
          );
          setStatus(t("status.oauthLoginDone"));
          if (result.state) {
            currentState = result.state;
            lastEditorState = result.state;
          }
          await loadState();
          const refreshed = currentState.customProviders.find((item) => item.id === editingProviderId);
          if (refreshed && !providerModal.hidden) editProvider(refreshed);
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          providerLoginButton.disabled = false;
        }
      }

      // Open the provider modal for either create or edit mode.
      function openProviderModal() {
        providerModal.hidden = false;
        document.body.classList.add("modal-open");
        providerIdEl.focus();
        closeAllCombos();
      }

      // Close the provider modal without saving.
      function closeProviderModal() {
        providerModal.hidden = true;
        document.body.classList.remove("modal-open");
        closeAllCombos();
      }

      // Start creating a new provider in the same modal used for edits.
      function newProvider() {
        resetProviderForm();
        openProviderModal();
      }

      // Render default summaries from the current config snapshot.
      function renderEffectiveDefaults(state) {
        if (!state) return;
        document.querySelector("#effective-defaults").textContent = t("config.effective", {
          model: state.effectiveDefaultModel.value || t("config.interactiveSelector"),
          modelSource: state.effectiveDefaultModel.source,
          provider: state.effectiveDefaultProvider.value,
          providerSource: state.effectiveDefaultProvider.source,
        });
        document.querySelector("#terminal-effective").textContent = t("terminal.default", {
          provider: state.effectiveDefaultProvider.value || "-",
          model: state.effectiveDefaultModel.value || "-",
        });
      }

      // Load the current editable config snapshot from the server.
      async function loadState() {
        const state = await requestJson("/api/config");
        currentState = state;
        lastEditorState = state;
        updateComboOptions("models", allBareModelOptions());
        updateComboOptions("providers", state.providerOptions);
        updateComboOptions("formats", ["openai", "anthropic", "gemini"]);
        defaultModelEl.value = state.configDefaults.defaultModel || "";
        defaultProviderEl.value = state.configDefaults.defaultProvider || "";
        renderEffectiveDefaults(state);
        if (!chatModelEl.value) {
          chatModelEl.value = state.configDefaults.defaultModel || state.effectiveDefaultModel.value || "";
        }
        if (!chatProviderEl.value) {
          chatProviderEl.value = state.configDefaults.defaultProvider || state.effectiveDefaultProvider.value || "";
        }
        refreshModelCombosForProvider();
        renderProviders("#provider-summary", state.customProviders, false);
        renderProviders("#provider-list", state.customProviders, true);
      }

      // 读取飞书账号配置；保存后后台 watcher 会负责热更新。
      async function loadFeishuConfig() {
        feishuConfigState = await requestJson("/api/feishu-config");
        editingFeishuAccountIndexes = new Set();
        newFeishuAccountIndexes = new Set();
        hasFeishuDraftChanges = false;
        renderFeishuConfig(feishuConfigState);
      }

      // 渲染配置页频道概览和频道页飞书账号卡片。
      function renderFeishuConfig(state) {
        renderConfigChannelSummary();
        renderFeishuAccountSections(state);
      }

      // 账号卡片按飞书账号分组，每个账号下面展示自己的会话记录。
      function renderFeishuAccountSections(state) {
        if (!feishuAccountListEl) return;
        const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
        feishuAccountListEl.replaceChildren();
        const sessionsByAccount = groupFeishuSessionsByAccount(currentFeishuSessions());
        const allSessions = currentFeishuSessions();
        channelFeishuSessionCountEl.textContent = t("channels.sessionCount", {
          count: String(allSessions.length),
        });
        updateFeishuBulkActions();
        syncFeishuSessionDrawer(allSessions);

        if (accounts.length === 0) {
          const empty = document.createElement("div");
          empty.className = "provider-model-empty";
          empty.textContent = t("feishuConfig.empty");
          feishuAccountListEl.appendChild(empty);
          return;
        }
        accounts.forEach((account, index) => {
          feishuAccountListEl.appendChild(
            createFeishuAccountCard(
              account,
              index,
              sessionsByAccount.get(account.id || "default") || []
            )
          );
        });
      }

      function createFeishuAccountCard(account, index, sessions) {
        const isEditing = editingFeishuAccountIndexes.has(index);
        const card = document.createElement("div");
        card.className = "feishu-account-card";
        card.dataset.accountIndex = String(index);

        const head = document.createElement("div");
        head.className = "feishu-account-head";
        const titleWrap = document.createElement("div");
        titleWrap.className = "feishu-account-title";
        const title = document.createElement("strong");
        title.textContent = account.id || "default";
        const meta = document.createElement("span");
        meta.className = "source";
        meta.textContent = [
          account.enabled === false ? "disabled" : "enabled",
          account.model || "-",
          account.cwd || "-",
        ].join(" · ");
        titleWrap.append(title, meta);

        const actions = document.createElement("div");
        actions.className = "feishu-account-actions";
        const edit = document.createElement("button");
        edit.className = "ghost";
        edit.type = "button";
        edit.textContent = t("feishuConfig.edit");
        edit.addEventListener("click", () => setFeishuAccountEditing(index, true));
        const cancel = document.createElement("button");
        cancel.className = "ghost";
        cancel.type = "button";
        cancel.textContent = t("common.cancel");
        cancel.addEventListener("click", () => cancelFeishuAccountEdit(index));
        const save = document.createElement("button");
        save.className = "ghost";
        save.type = "button";
        save.textContent = t("feishuConfig.saveAccount");
        save.addEventListener("click", () => saveFeishuAccount(index));
        const remove = document.createElement("button");
        remove.className = "ghost secondary";
        remove.type = "button";
        remove.textContent = t("feishuConfig.remove");
        remove.addEventListener("click", () => {
          removeFeishuAccount(index);
        });
        if (isEditing) {
          actions.append(cancel, save, remove);
        } else {
          actions.append(edit, remove);
        }
        head.append(titleWrap, actions);

        const fields = document.createElement("div");
        fields.className = "feishu-account-fields";
        fields.append(
          createFeishuInput("ID", "id", account.id || "default", { disabled: !isEditing }),
          createFeishuInput("App ID", "appId", account.appId || "", { disabled: !isEditing }),
          createFeishuSecretInput(account, !isEditing),
          createFeishuInput(t("feishuConfig.botOpenId"), "botOpenId", account.botOpenId || "", {
            disabled: !isEditing,
          }),
          createFeishuDomainField(account.domain || "feishu", !isEditing),
          createFeishuInput(t("channels.model"), "model", account.model || "", { readonly: true }),
          createFeishuInput(t("channels.cwd"), "cwd", account.cwd || "", { readonly: true }),
          createFeishuInput("Session", "sessionMode", account.sessionMode || "", { readonly: true })
        );

        const flags = document.createElement("div");
        flags.className = "feishu-account-flags";
        flags.append(
          createFeishuCheckbox(t("feishuConfig.enabled"), "enabled", account.enabled !== false, !isEditing),
          createFeishuCheckbox(
            t("feishuConfig.progress"),
            "sendProgressReplies",
            account.sendProgressReplies === true,
            !isEditing
          )
        );

        card.append(
          head,
          fields,
          flags,
          createFeishuAccountSessions(account, sessions)
        );
        return card;
      }

      function createFeishuSecretInput(account, disabled) {
        const label = document.createElement("label");
        const span = document.createElement("span");
        span.textContent = t("feishuConfig.appSecret");
        const wrapper = document.createElement("div");
        wrapper.className = "secret-field";
        const input = document.createElement("input");
        input.dataset.field = "appSecret";
        input.value = account.appSecret || "";
        input.type = "password";
        input.placeholder = account.hasAppSecret ? SECRET_MASK : "";
        if (account.hasAppSecret) input.dataset.masked = "true";
        if (disabled) input.disabled = true;
        const toggle = document.createElement("button");
        toggle.className = "secret-toggle feishu-secret-toggle";
        toggle.type = "button";
        toggle.setAttribute("aria-label", t("feishuConfig.showSecret"));
        toggle.title = t("feishuConfig.showSecret");
        toggle.addEventListener("click", () => {
          toggleFeishuSecretVisibility(input, toggle, account.id || "default");
        });
        wrapper.append(input, toggle);
        const help = document.createElement("span");
        help.className = "field-help";
        help.textContent = t("feishuConfig.secretHelp");
        label.append(span, wrapper, help);
        return label;
      }

      function createFeishuInput(labelText, field, value, options = {}) {
        const label = document.createElement("label");
        if (options.readonly) label.className = "readonly-field";
        const span = document.createElement("span");
        span.textContent = labelText;
        const input = document.createElement("input");
        input.dataset.field = field;
        input.value = value || "";
        input.type = options.type || "text";
        if (options.placeholder) input.placeholder = options.placeholder;
        if (options.readonly) input.readOnly = true;
        if (options.disabled) input.disabled = true;
        label.append(span, input);
        if (options.help) {
          const help = document.createElement("span");
          help.className = "field-help";
          help.textContent = options.help;
          label.appendChild(help);
        }
        return label;
      }

      function createFeishuDomainField(value, disabled = false) {
        const label = document.createElement("label");
        const span = document.createElement("span");
        span.textContent = t("feishuConfig.domain");
        const select = document.createElement("select");
        select.dataset.field = "domain";
        select.disabled = disabled;
        for (const domain of ["feishu", "lark"]) {
          const option = document.createElement("option");
          option.value = domain;
          option.textContent = domain;
          option.selected = domain === value;
          select.appendChild(option);
        }
        label.append(span, select);
        return label;
      }

      function createFeishuCheckbox(labelText, field, checked, disabled = false) {
        const label = document.createElement("label");
        label.className = "check-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.field = field;
        input.checked = checked;
        input.disabled = disabled;
        const span = document.createElement("span");
        span.textContent = labelText;
        label.append(input, span);
        return label;
      }

      async function toggleFeishuSecretVisibility(input, toggle, accountId) {
        const shouldReveal = input.type === "password";
        if (!shouldReveal) {
          input.type = "password";
          toggle.classList.remove("revealed");
          toggle.setAttribute("aria-label", t("feishuConfig.showSecret"));
          toggle.title = t("feishuConfig.showSecret");
          return;
        }

        try {
          if (input.dataset.masked === "true") {
            const secret = await requestJson(
              "/api/feishu-config/" + encodeURIComponent(accountId) + "/secret"
            );
            input.value = secret.appSecret || "";
            delete input.dataset.masked;
          }
          input.type = "text";
          toggle.classList.add("revealed");
          toggle.setAttribute("aria-label", t("feishuConfig.hideSecret"));
          toggle.title = t("feishuConfig.hideSecret");
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      // 账号会话用轻量列表承载，完整过程仍交给右侧聊天抽屉展示。
      function createFeishuAccountSessions(account, sessions) {
        const section = document.createElement("div");
        section.className = "feishu-account-sessions";
        const heading = document.createElement("div");
        heading.className = "source";
        heading.textContent = t("channels.sessionCount", { count: String(sessions.length) });
        const list = document.createElement("div");
        list.className = "feishu-session-list";
        if (sessions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "provider-model-empty";
          empty.textContent = t("channels.sessionEmpty");
          list.appendChild(empty);
        } else {
          for (const session of sessions) {
            list.appendChild(createFeishuAccountSessionRow(session));
          }
        }
        section.append(heading, list);
        return section;
      }

      function createFeishuAccountSessionRow(session) {
        const row = document.createElement("div");
        row.className = "feishu-session-row";
        const currentMessage = session.currentMessage || {};
        row.append(
          feishuSessionText(t("channels.messageSource." + (session.chatKind || "direct"))),
          feishuSessionText(session.preview || currentMessage.preview || "-"),
          feishuSessionStage(session.stage || currentMessage.stage || "received"),
          feishuSessionText(formatDurationMs(session.elapsedMs ?? currentMessage.elapsedMs)),
          feishuSessionOpenButton(session)
        );
        return row;
      }

      function feishuSessionText(value) {
        const span = document.createElement("span");
        span.textContent = value || "-";
        span.title = span.textContent;
        return span;
      }

      function feishuSessionStage(stage) {
        const span = document.createElement("span");
        span.appendChild(feishuStageBadge(stage));
        return span;
      }

      function feishuSessionOpenButton(session) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost channel-session-detail-button";
        button.textContent = session.error
          ? compactErrorText(session.error)
          : t("channels.sessionDetailsButton");
        button.title = session.error || t("channels.sessionDetails");
        button.addEventListener("click", () => openFeishuSessionDrawer(session));
        return button;
      }

      function collectFeishuAccounts() {
        return Array.from(feishuAccountListEl.querySelectorAll(".feishu-account-card")).map((card) => {
          const account = {};
          for (const field of card.querySelectorAll("[data-field]")) {
            const key = field.dataset.field;
            if (field.type === "checkbox") {
              account[key] = field.checked;
            } else if (!field.readOnly) {
              account[key] = field.value;
            }
          }
          return account;
        });
      }

      async function saveFeishuAccounts() {
        feishuConfigState = await requestJson("/api/feishu-config", {
          method: "POST",
          body: JSON.stringify({ accounts: collectFeishuAccounts() }),
        });
        editingFeishuAccountIndexes = new Set();
        newFeishuAccountIndexes = new Set();
        hasFeishuDraftChanges = false;
        renderFeishuConfig(feishuConfigState);
        setStatus(t("status.feishuConfigSaved"));
        await loadChannels();
      }

      async function saveFeishuAccount(index) {
        await saveFeishuAccounts();
        editingFeishuAccountIndexes.delete(index);
      }

      function setFeishuAccountEditing(index, isEditing) {
        if (isEditing) editingFeishuAccountIndexes.add(index);
        else editingFeishuAccountIndexes.delete(index);
        renderFeishuConfig(feishuConfigState);
      }

      function cancelFeishuAccountEdit(index) {
        if (newFeishuAccountIndexes.has(index)) {
          removeFeishuAccount(index, false);
          hasFeishuDraftChanges = editingFeishuAccountIndexes.size > 0;
          renderFeishuConfig(feishuConfigState);
          return;
        }
        editingFeishuAccountIndexes.delete(index);
        renderFeishuConfig(feishuConfigState);
      }

      function setAllFeishuAccountsEditing(isEditing) {
        editingFeishuAccountIndexes = new Set();
        if (isEditing) {
          const accounts = Array.isArray(feishuConfigState.accounts) ? feishuConfigState.accounts : [];
          accounts.forEach((_, index) => editingFeishuAccountIndexes.add(index));
        }
        renderFeishuConfig(feishuConfigState);
      }

      async function cancelFeishuAllEdits() {
        await loadFeishuConfig();
      }

      function updateFeishuBulkActions() {
        const hasEdits = editingFeishuAccountIndexes.size > 0 || hasFeishuDraftChanges;
        feishuEditAllEl.hidden = hasEdits;
        feishuCancelAllEl.hidden = !hasEdits;
        feishuSaveAllEl.hidden = !hasEdits;
      }

      function removeFeishuAccount(index, markDraft = true) {
        feishuConfigState.accounts.splice(index, 1);
        editingFeishuAccountIndexes = shiftedFeishuIndexesAfterRemoval(editingFeishuAccountIndexes, index);
        newFeishuAccountIndexes = shiftedFeishuIndexesAfterRemoval(newFeishuAccountIndexes, index);
        if (markDraft) hasFeishuDraftChanges = true;
        renderFeishuConfig(feishuConfigState);
      }

      function shiftedFeishuIndexesAfterRemoval(indexes, removedIndex) {
        const next = new Set();
        for (const index of indexes) {
          if (index === removedIndex) continue;
          next.add(index > removedIndex ? index - 1 : index);
        }
        return next;
      }

      function addFeishuAccount() {
        const accounts = Array.isArray(feishuConfigState.accounts) ? feishuConfigState.accounts : [];
        feishuConfigState.accounts = accounts;
        const index = accounts.length;
        accounts.push({
          id: "new-account",
          enabled: true,
          appId: "",
          appSecret: "",
          hasAppSecret: false,
          botOpenId: "",
          domain: "feishu",
          sendProgressReplies: false,
        });
        editingFeishuAccountIndexes.add(index);
        newFeishuAccountIndexes.add(index);
        renderFeishuConfig(feishuConfigState);
      }

      // Fetch the local Claudish usage aggregate and render the dashboard.
      async function loadUsageDashboard() {
        const dashboard = await requestJson("/api/usage" + buildUsageQuery());
        usageState = dashboard;
        renderUsageDashboard(dashboard);
      }

      // 拉取后台服务中的频道状态。
      async function loadChannels() {
        const status = await requestJson("/api/channels");
        channelsState = status;
        renderChannels(status);
      }

      // 渲染 Feishu 等外部频道的运行状态。
      function renderChannels(status) {
        const channels = Array.isArray(status?.channels) ? status.channels : [];
        const feishuChannels = channels.filter(
          (channel) => channel.id === "feishu" || String(channel.id || "").startsWith("feishu:")
        );
        const summaries = channelSummaries(feishuChannels);
        channelsStatusEl.textContent =
          summaries.length === 0 ? t("channels.none") : t("usage.requestCount", { count: summaries.length });
        renderChannelList(summaries);
        renderChannelDetail(summaries);
        renderConfigChannelSummary();
        renderFeishuSessions(feishuChannels);
      }

      // 频道页左侧先展示每个频道，避免账号和会话直接铺满页面。
      function renderChannelList(summaries) {
        if (!channelListEl) return;
        channelListEl.replaceChildren();
        for (const summary of summaries) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "channel-list-card" + (summary.id === selectedChannelId ? " active" : "");
          button.dataset.channelId = summary.id;
          button.append(
            channelSummaryTitle(summary.title),
            channelMetricRow(summary)
          );
          button.addEventListener("click", () => {
            selectedChannelId = summary.id;
            renderChannelList(summaries);
            renderChannelDetail(summaries);
          });
          channelListEl.appendChild(button);
        }
      }

      function renderChannelDetail(summaries) {
        if (!channelDetailEl) return;
        const selected = summaries.find((summary) => summary.id === selectedChannelId) || summaries[0];
        if (!selected) {
          channelFeishuDetailEl.hidden = true;
          channelEmptyDetailEl.hidden = false;
          return;
        }
        selectedChannelId = selected.id;
        const isFeishu = selected.id === "feishu";
        channelFeishuDetailEl.hidden = !isFeishu;
        channelEmptyDetailEl.hidden = isFeishu;
      }

      // 配置页只显示频道概览，具体账号配置入口留在频道页。
      function renderConfigChannelSummary() {
        if (!configChannelSummaryEl) return;
        configChannelSummaryEl.replaceChildren();
        for (const summary of channelSummaries(currentFeishuChannels())) {
          const card = document.createElement("div");
          card.className = "channel-overview-card";
          card.append(
            channelSummaryTitle(summary.title),
            channelMetricRow(summary),
            channelSourceLine(summary.status)
          );
          configChannelSummaryEl.appendChild(card);
        }
      }

      function channelSummaries(feishuChannels) {
        const accounts = Array.isArray(feishuConfigState?.accounts) ? feishuConfigState.accounts : [];
        const sessions = feishuChannels
          .flatMap((channel) => collectFeishuSessions(channel))
          .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
        const activeSessions = feishuChannels.reduce(
          (total, channel) => total + Number(channel.activeSessions || 0),
          0
        );
        const enabledAccounts = accounts.filter((account) => account.enabled !== false).length;
        return [
          {
            id: "feishu",
            title: t("channels.feishu"),
            configured: accounts.length,
            enabled: enabledAccounts,
            activeSessions,
            sessionCount: sessions.length,
            status: resolveFeishuAggregateStatus(feishuChannels, accounts),
          },
          {
            id: "web-chat",
            title: t("channels.webChat"),
            configured: 1,
            enabled: 1,
            activeSessions: terminalSocket ? 1 : 0,
            sessionCount: terminalSocket ? 1 : 0,
            status: terminalSocket ? "connected" : "available",
          },
        ];
      }

      function channelSummaryTitle(title) {
        const strong = document.createElement("strong");
        strong.textContent = title;
        return strong;
      }

      function channelMetricRow(summary) {
        const row = document.createElement("div");
        row.className = "channel-metrics";
        row.append(
          channelMetric(t("channels.configuredAccounts", { count: String(summary.configured || 0) })),
          channelMetric(t("channels.enabledAccounts", { count: String(summary.enabled || 0) })),
          channelMetric(t("channels.sessionCount", { count: String(summary.sessionCount || 0) })),
          channelMetric(t("channels.activeSessions", { count: String(summary.activeSessions || 0) }))
        );
        return row;
      }

      function channelMetric(text) {
        const item = document.createElement("span");
        item.className = "channel-metric";
        item.textContent = text;
        return item;
      }

      function channelSourceLine(text) {
        const line = document.createElement("div");
        line.className = "source";
        line.textContent = text || "-";
        return line;
      }

      function resolveFeishuAggregateStatus(feishuChannels, accounts) {
        if (!accounts.length) return "not_configured";
        if (accounts.every((account) => account.enabled === false)) return "disabled";
        if (feishuChannels.some((channel) => channel.status === "connected")) return "connected";
        return feishuChannels[0]?.status || "configured";
      }

      function currentFeishuChannels() {
        const channels = Array.isArray(channelsState?.channels) ? channelsState.channels : [];
        return channels.filter(
          (channel) => channel.id === "feishu" || String(channel.id || "").startsWith("feishu:")
        );
      }

      function currentFeishuSessions() {
        return currentFeishuChannels()
          .flatMap((channel) => collectFeishuSessions(channel))
          .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
      }

      function groupFeishuSessionsByAccount(sessions) {
        const groups = new Map();
        for (const session of sessions) {
          const accountId = session.accountId || "default";
          const list = groups.get(accountId) || [];
          list.push(session);
          groups.set(accountId, list);
        }
        return groups;
      }

      // 刷新账号卡里的会话记录，不再生成全局消息表。
      function renderFeishuSessions(feishuChannels) {
        const sessions = feishuChannels
          .flatMap((channel) => collectFeishuSessions(channel))
          .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

        channelFeishuSessionCountEl.textContent = t("channels.sessionCount", {
          count: String(sessions.length),
        });
        renderFeishuAccountSections(feishuConfigState);
        syncFeishuSessionDrawer(sessions);
      }

      // 从新版会话状态读取数据，旧状态则按 conversationKey 兜底聚合。
      function collectFeishuSessions(channel) {
        const accountId = channel.accountId || resolveFeishuAccountId(channel);
        if (Array.isArray(channel.recentSessions)) {
          return channel.recentSessions.map((session) => ({
            ...session,
            accountId: session.accountId || accountId,
          }));
        }

        const messages = Array.isArray(channel.recentMessages)
          ? channel.recentMessages.map((message) => ({
              ...message,
              accountId: message.accountId || accountId,
            }))
          : [];
        const sessions = new Map();
        for (const message of messages) {
          const key = message.conversationKey || message.messageId || "unknown";
          const existing = sessions.get(key);
          if (!existing) {
            sessions.set(key, {
              accountId: message.accountId || accountId,
              conversationKey: key,
              chatKind: message.chatKind || "direct",
              senderName: message.senderName || "-",
              preview: message.preview || "-",
              imageCount: Number(message.imageCount || 0),
              fileCount: Number(message.fileCount || 0),
              messageCount: 1,
              stage: message.stage || "received",
              startedAt: message.receivedAt,
              updatedAt: message.updatedAt || message.receivedAt,
              elapsedMs: message.elapsedMs,
              error: message.error,
              output: message.output,
              currentMessage: message,
              messages: [message],
            });
            continue;
          }
          existing.messageCount += 1;
          existing.messages.push(message);
          existing.startedAt = Math.min(Number(existing.startedAt || 0), Number(message.receivedAt || 0));
          existing.updatedAt = Math.max(Number(existing.updatedAt || 0), Number(message.updatedAt || message.receivedAt || 0));
        }
        return Array.from(sessions.values());
      }

      // 生成单条飞书会话状态行，详情通过右侧抽屉展示。
      function createFeishuSessionRows(session) {
        const row = document.createElement("tr");
        const currentMessage = session.currentMessage || {};
        const sessionKey = feishuSessionKey(session);
        row.append(
          feishuMessageCell(session.accountId || "-"),
          feishuMessageCell(t("channels.messageSource." + (session.chatKind || "direct"))),
          feishuMessageCell(session.conversationKey || "-"),
          feishuMessageCell(session.senderName || currentMessage.senderName || "-"),
          feishuMessageCell(session.preview || currentMessage.preview || "-"),
          feishuMessageCell(String(session.imageCount || currentMessage.imageCount || 0)),
          feishuMessageCell(String(session.fileCount || currentMessage.fileCount || 0)),
          feishuStageCell(session.stage || currentMessage.stage || "received"),
          feishuMessageCell(formatDurationMs(session.elapsedMs ?? currentMessage.elapsedMs)),
          feishuSessionDetailsCell(session, sessionKey)
        );

        return [row];
      }

      // 生成普通消息单元格并设置 title，长文本靠浏览器悬停查看。
      function feishuMessageCell(value) {
        const cell = document.createElement("td");
        cell.textContent = value;
        cell.title = value;
        return cell;
      }

      // 生成可点击的会话详情入口。
      function feishuSessionDetailsCell(session, sessionKey) {
        const cell = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost channel-session-detail-button";
        button.textContent = session.error
          ? compactErrorText(session.error)
          : t("channels.sessionDetailsButton");
        button.title = session.error || t("channels.sessionDetails");
        button.addEventListener("click", () => openFeishuSessionDrawer(session));
        cell.appendChild(button);
        return cell;
      }

      // 打开右侧会话抽屉，并记录当前 session，便于轮询刷新时保持内容更新。
      function openFeishuSessionDrawer(session) {
        activeFeishuSessionKey = feishuSessionKey(session);
        renderFeishuSessionDrawer(session);
        feishuSessionDrawerEl.hidden = false;
        document.body.classList.add("drawer-open");
        window.requestAnimationFrame(() => {
          feishuSessionDrawerEl.classList.add("open");
        });
      }

      // 关闭右侧会话抽屉。
      function closeFeishuSessionDrawer() {
        activeFeishuSessionKey = "";
        feishuSessionDrawerEl.classList.remove("open");
        document.body.classList.remove("drawer-open");
        feishuSessionDrawerEl.hidden = true;
      }

      // 频道状态刷新时，如果抽屉正打开，就用最新 session 数据刷新抽屉。
      function syncFeishuSessionDrawer(sessions) {
        if (!activeFeishuSessionKey || feishuSessionDrawerEl.hidden) return;
        const session = sessions.find((item) => feishuSessionKey(item) === activeFeishuSessionKey);
        if (!session) {
          closeFeishuSessionDrawer();
          return;
        }
        renderFeishuSessionDrawer(session);
      }

      // 渲染右侧抽屉里的 session 详情。
      function renderFeishuSessionDrawer(session) {
        const currentMessage = session.currentMessage || {};
        const title = session.senderName || currentMessage.senderName || session.conversationKey || "-";
        const stage = t("channels.messageStage." + (session.stage || currentMessage.stage || "received"));
        feishuSessionDrawerTitleEl.textContent = title;
        feishuSessionDrawerSubtitleEl.textContent = [
          t("channels.messageSource." + (session.chatKind || "direct")),
          session.conversationKey || "-",
          stage,
          formatDurationMs(session.elapsedMs ?? currentMessage.elapsedMs),
        ].filter(Boolean).join(" · ");
        feishuSessionDrawerMetaEl.replaceChildren(
          feishuDetailItem(t("channels.messageConversation"), session.conversationKey || "-"),
          feishuDetailItem(t("channels.messageAccount"), session.accountId || "-"),
          feishuDetailItem(t("channels.sessionCurrentMessage"), currentMessage.messageId || "-"),
          feishuDetailItem(t("channels.sessionMessageCount"), String(session.messageCount || 0)),
          feishuDetailItem(t("channels.messageReceivedAt"), formatMessageTimestamp(currentMessage.receivedAt || session.startedAt)),
          feishuDetailItem(t("channels.messageStage"), t("channels.messageStage." + (session.stage || currentMessage.stage || "received")))
        );
        feishuSessionDrawerBodyEl.replaceChildren(
          createFeishuSessionChatThread(session, currentMessage),
          createFeishuRawLog(session, currentMessage)
        );
        if (session.error || currentMessage.error) {
          feishuSessionDrawerBodyEl.append(
            feishuDetailPre(
              t("channels.messageError"),
              session.error || currentMessage.error,
              "channel-message-error-text"
            )
          );
        }
      }

      // 把一个 session 渲染成自然阅读的聊天线程。
      function createFeishuSessionChatThread(session, currentMessage) {
        const wrapper = document.createElement("div");
        wrapper.className = "feishu-chat-thread";
        const heading = document.createElement("div");
        heading.className = "feishu-chat-heading";
        heading.textContent = t("channels.sessionTimeline");
        wrapper.appendChild(heading);

        const messages = normalizedFeishuSessionMessages(session, currentMessage);
        if (messages.length === 0) {
          wrapper.appendChild(createFeishuAssistantBubble(t("channels.sessionNoEvents")));
          return wrapper;
        }

        for (const message of messages) {
          wrapper.appendChild(createFeishuMessageTurn(message));
        }
        return wrapper;
      }

      // 会话里的消息按接收时间展示，避免最新消息把上下文倒过来。
      function normalizedFeishuSessionMessages(session, currentMessage) {
        const messages = Array.isArray(session.messages) ? session.messages.filter(Boolean) : [];
        const fallback = currentMessage && Object.keys(currentMessage).length > 0 ? [currentMessage] : [];
        return (messages.length > 0 ? messages : fallback)
          .slice()
          .sort((left, right) => Number(left.receivedAt || 0) - Number(right.receivedAt || 0));
      }

      // 渲染一条飞书消息，以及它触发的模型输出和工具事件。
      function createFeishuMessageTurn(message) {
        const turn = document.createElement("div");
        turn.className = "feishu-message-turn";
        turn.append(
          createFeishuTurnMeta(message),
          createFeishuUserBubble(message)
        );

        const events = Array.isArray(message.progressEvents) ? message.progressEvents : [];
        if (events.length > 0) {
          for (const event of events) {
            const node = createFeishuProgressEvent(event);
            if (node) turn.appendChild(node);
          }
        } else if (message.output) {
          turn.appendChild(createFeishuFallbackOutput(message.output));
        } else {
          turn.appendChild(createFeishuAssistantBubble(t("channels.sessionNoEvents")));
        }

        if (message.error) {
          turn.appendChild(createFeishuErrorBubble(message.error));
        }
        return turn;
      }

      // 生成单条消息的轻量元信息。
      function createFeishuTurnMeta(message) {
        const meta = document.createElement("div");
        meta.className = "feishu-turn-meta";
        const time = document.createElement("span");
        time.textContent = formatMessageTimestamp(message.receivedAt);
        const sender = document.createElement("code");
        sender.textContent = message.senderName || "-";
        sender.title = sender.textContent;
        const stage = document.createElement("span");
        stage.textContent = t("channels.messageStage." + (message.stage || "received"));
        meta.append(time, sender, stage);
        return meta;
      }

      // 用户消息气泡里只放用户可读内容，图片和文件用附件小条表示。
      function createFeishuUserBubble(message) {
        const bubble = createFeishuBubble("user", t("channels.sessionUser"), message.preview || "-");
        const attachments = document.createElement("div");
        attachments.className = "feishu-attachment-row";
        if (Number(message.imageCount || 0) > 0) {
          attachments.appendChild(createFeishuAttachmentPill(t("channels.messageImages"), message.imageCount));
        }
        const files = normalizedFeishuFileAttachments(message.fileAttachments);
        if (files.length > 0) {
          for (const file of files) {
            attachments.appendChild(createFeishuFileAttachmentButton(file));
          }
        } else if (Number(message.fileCount || 0) > 0) {
          attachments.appendChild(createFeishuAttachmentPill(t("channels.messageFiles"), message.fileCount));
        }
        if (attachments.childNodes.length > 0) bubble.appendChild(attachments);
        return bubble;
      }

      // 普通附件只展示数量，带本地路径的文件会单独渲染成可打开按钮。
      function createFeishuAttachmentPill(label, count) {
        const pill = document.createElement("span");
        pill.className = "feishu-attachment-pill";
        pill.textContent = label + " ×" + String(count || 0);
        return pill;
      }

      // 过滤掉历史状态里没有本地路径的附件，避免生成点不开的文件按钮。
      function normalizedFeishuFileAttachments(files) {
        if (!Array.isArray(files)) return [];
        return files
          .map((file) => ({
            name: feishuLocalFileName(file && (file.name || file.path)),
            path: typeof file?.path === "string" ? file.path : "",
          }))
          .filter((file) => file.path);
      }

      // 文件名从后端元数据优先取，旧数据则从路径里兜底提取。
      function feishuLocalFileName(value) {
        const parts = String(value || "").split(/[\\\\/]/).filter(Boolean);
        return parts[parts.length - 1] || t("channels.messageFiles");
      }

      // 生成可点击的本地文件附件按钮。
      function createFeishuFileAttachmentButton(file) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "feishu-attachment-pill feishu-file-pill";
        button.textContent = file.name;
        button.title = file.path;
        button.addEventListener("click", () => openFeishuLocalFile(file.path));
        return button;
      }

      // 通过本地后端打开文件，后端会再次校验路径是否属于飞书文件缓存。
      async function openFeishuLocalFile(path) {
        if (!path) return;
        try {
          await requestJson("/api/open-local-file", {
            method: "POST",
            body: JSON.stringify({ path }),
          });
        } catch (err) {
          setStatus(err.message, true);
        }
      }

      // 结构化模型过程事件按类型渲染成气泡或折叠卡片。
      function createFeishuProgressEvent(event) {
        if (!event || typeof event !== "object") return null;
        if (event.type === "assistant_text") {
          return createFeishuAssistantBubble(event.text || "-");
        }
        if (event.type === "tool_start") {
          return createFeishuToolCard(
            t("channels.sessionTool") + " · " + (event.name || "tool"),
            t("channels.sessionToolInput"),
            formatEventPayload(event.input)
          );
        }
        if (event.type === "tool_result") {
          return createFeishuToolCard(
            event.isError
              ? t("channels.sessionToolResult") + " · " + t("channels.sessionToolFailed")
              : t("channels.sessionToolResult"),
            t("channels.sessionToolResult"),
            event.text || "-",
            Boolean(event.isError)
          );
        }
        if (event.type === "stderr") {
          return createFeishuToolCard(
            t("channels.sessionStderr"),
            t("channels.sessionStderr"),
            event.text || "-",
            true
          );
        }
        return null;
      }

      // 旧状态只有 output 字符串时，默认折叠，避免长日志继续撑满详情。
      function createFeishuFallbackOutput(output) {
        return createFeishuToolCard(
          t("channels.sessionRawLog"),
          t("channels.sessionRawLog"),
          output || "-"
        );
      }

      // 生成 assistant 文本气泡。
      function createFeishuAssistantBubble(text) {
        const bubble = document.createElement("div");
        bubble.className = "feishu-chat-bubble assistant";
        const name = document.createElement("span");
        name.className = "feishu-bubble-label";
        name.textContent = t("channels.sessionAssistant");
        const body = document.createElement("div");
        body.className = "feishu-bubble-body";
        renderFeishuAssistantText(body, text || "-");
        bubble.append(name, body);
        return bubble;
      }

      // 生成错误提示气泡。
      function createFeishuErrorBubble(text) {
        return createFeishuBubble("error", t("channels.messageError"), text || "-");
      }

      // 生成通用聊天气泡。
      function createFeishuBubble(role, label, text) {
        const bubble = document.createElement("div");
        bubble.className = "feishu-chat-bubble " + role;
        const name = document.createElement("span");
        name.className = "feishu-bubble-label";
        name.textContent = label;
        const body = document.createElement("div");
        body.textContent = text || "-";
        bubble.append(name, body);
        return bubble;
      }

      // 把模型回复拆成普通文本和 fence 块，避免代码或 markdown 混在一整段里。
      function renderFeishuAssistantText(target, text) {
        target.replaceChildren();
        for (const block of parseFeishuFencedBlocks(text || "-")) {
          if (block.type === "fence") {
            target.appendChild(createFeishuFencedBlock(block.language, block.text));
          } else {
            const paragraph = document.createElement("div");
            paragraph.className = "feishu-bubble-text";
            paragraph.textContent = block.text || "-";
            target.appendChild(paragraph);
          }
        }
      }

      // 兼容两种三字符 fence 标记，语言写在起始行后面。
      function parseFeishuFencedBlocks(text) {
        const blocks = [];
        const lines = String(text || "").split(/\r?\n/);
        let plain = [];
        let fence = "";
        let language = "";
        let fenced = [];

        const flushPlain = () => {
          const value = plain.join("\n").trim();
          if (value) blocks.push({ type: "text", text: value });
          plain = [];
        };
        const flushFence = () => {
          blocks.push({
            type: "fence",
            language: language || "text",
            text: fenced.join("\n").trim(),
          });
          fence = "";
          language = "";
          fenced = [];
        };

        for (const line of lines) {
          const start = line.match(/^(\x60{3}|''')\s*([A-Za-z0-9_-]*)\s*$/);
          if (!fence && start) {
            flushPlain();
            fence = start[1];
            language = start[2] || "text";
            continue;
          }
          if (fence && line.trim() === fence) {
            flushFence();
            continue;
          }
          if (fence) {
            fenced.push(line);
          } else {
            plain.push(line);
          }
        }
        if (fence) flushFence();
        flushPlain();
        return blocks.length > 0 ? blocks : [{ type: "text", text: "-" }];
      }

      // fence 块按语言渲染：markdown 用轻量排版，其他语言按代码块展示。
      function createFeishuFencedBlock(language, text) {
        const block = document.createElement("div");
        block.className = "feishu-fenced-block";
        const label = document.createElement("div");
        label.className = "feishu-fenced-label";
        label.textContent = language || "text";
        block.appendChild(label);
        if (String(language || "").toLowerCase() === "markdown") {
          const markdown = document.createElement("div");
          markdown.className = "feishu-fenced-markdown";
          renderFeishuMarkdownText(markdown, text);
          block.appendChild(markdown);
          return block;
        }

        const content = document.createElement("pre");
        content.className = "feishu-fenced-content";
        content.textContent = text || "-";
        block.appendChild(content);
        return block;
      }

      // 只做安全的轻量 markdown 展示，不把模型文本当 HTML 注入页面。
      function renderFeishuMarkdownText(target, text) {
        target.replaceChildren();
        const lines = String(text || "-").split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
          const item = trimmed.match(/^[-*]\s+(.+)$/);
          const node = document.createElement("div");
          if (heading) {
            node.className = "feishu-md-heading";
            node.textContent = heading[2];
          } else if (item) {
            node.className = "feishu-md-list-item";
            node.textContent = "• " + item[1];
          } else {
            node.className = "feishu-md-paragraph";
            node.textContent = trimmed;
          }
          target.appendChild(node);
        }
      }

      // 工具调用、工具结果和 stderr 统一封装成可折叠卡片。
      function createFeishuToolCard(title, label, body, isError = false) {
        const card = document.createElement("details");
        card.className = "feishu-tool-card" + (isError ? " error" : "");
        const summary = document.createElement("summary");
        summary.textContent = title;
        const content = document.createElement("pre");
        content.className = "feishu-tool-card-body";
        content.textContent = [label, body || "-"].filter(Boolean).join("\n\n");
        card.append(summary, content);
        return card;
      }

      // 原始日志保留为排查入口，但默认折叠。
      function createFeishuRawLog(session, currentMessage) {
        const raw = document.createElement("details");
        raw.className = "feishu-raw-log";
        const summary = document.createElement("summary");
        summary.textContent = t("channels.sessionRawLog");
        const body = document.createElement("pre");
        body.className = "feishu-raw-log-body";
        body.textContent = formatFeishuSessionMessageLog(
          normalizedFeishuSessionMessages(session, currentMessage)
        );
        raw.append(summary, body);
        return raw;
      }

      // 参数对象尽量格式化；字符串则原样显示。
      function formatEventPayload(value) {
        if (value === undefined || value === null || value === "") return "-";
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }

      // 生成详情里的长文本块。
      function feishuDetailPre(label, value, className) {
        const item = document.createElement("div");
        item.className = "channel-message-detail-item";
        const name = document.createElement("span");
        name.textContent = label;
        const content = document.createElement("pre");
        content.className = className;
        content.textContent = value || "-";
        item.append(name, content);
        return item;
      }

      // 将 session 内的消息压成可读日志，便于定位当前卡在哪条消息。
      function formatFeishuSessionMessageLog(messages) {
        return messages
          .filter(Boolean)
          .map((message) => {
            const lines = [
              [
                formatMessageTimestamp(message.receivedAt),
                t("channels.messageStage." + (message.stage || "received")),
                message.preview || "-",
              ].join(" · "),
            ];
            if (message.output) lines.push(message.output);
            if (message.error) lines.push(message.error);
            return lines.join("\n");
          })
          .join("\n\n") || "-";
      }

      // 生成错误详情里的键值块。
      function feishuDetailItem(label, value) {
        const item = document.createElement("div");
        item.className = "channel-message-detail-item";
        const name = document.createElement("span");
        name.textContent = label;
        const content = document.createElement("code");
        content.textContent = value;
        content.title = value;
        item.append(name, content);
        return item;
      }

      // 生成阶段标签单元格。
      function feishuStageCell(stage) {
        const cell = document.createElement("td");
        cell.appendChild(feishuStageBadge(stage));
        return cell;
      }

      function feishuStageBadge(stage) {
        const label = document.createElement("span");
        label.className = "channel-message-stage " + String(stage).replace(/[^a-z0-9_-]/gi, "");
        label.textContent = t("channels.messageStage." + stage);
        return label;
      }

      // 用账号和 conversationKey 生成稳定 key，避免多账号会话互相影响展开状态。
      function feishuSessionKey(session) {
        return [session.accountId || "default", session.conversationKey || ""].join(":");
      }

      // 错误按钮只显示短文本，完整内容放在展开详情里。
      function compactErrorText(error) {
        const normalized = String(error || "").replace(/\s+/g, " ").trim();
        return normalized.length > 42 ? normalized.slice(0, 39) + "..." : normalized || "-";
      }

      // 多飞书账号时，在同一个频道面板里按账号拆开展示。
      function resolveFeishuChannelTitle(channel) {
        const accountId = channel.accountId || resolveFeishuAccountId(channel);
        return accountId && accountId !== "default"
          ? t("channels.feishu") + " (" + accountId + ")"
          : t("channels.feishu");
      }

      // 从 channel id 里兜底拆出飞书账号名。
      function resolveFeishuAccountId(channel) {
        return String(channel.id || "").replace(/^feishu:?/, "") || "default";
      }

      // 生成频道面板标题。
      function channelRowTitle(text) {
        const title = document.createElement("h2");
        title.textContent = text;
        return title;
      }

      // 生成频道状态的紧凑键值行。
      function channelStatusRow(label, value) {
        const row = document.createElement("div");
        row.className = "channel-status-row";
        const name = document.createElement("span");
        name.textContent = label;
        const content = document.createElement("code");
        content.textContent = value;
        content.title = value;
        row.append(name, content);
        return row;
      }

      // 把毫秒耗时压成短文本，避免状态表格跳动。
      function formatDurationMs(value) {
        const ms = Math.max(0, Number(value || 0));
        if (ms < 1000) return Math.round(ms) + " ms";
        if (ms < 60_000) return (ms / 1000).toFixed(1).replace(/\.0$/, "") + " s";
        return (ms / 60_000).toFixed(1).replace(/\.0$/, "") + " min";
      }

      // 格式化飞书消息接收时间，非法时间保留为空占位。
      function formatMessageTimestamp(value) {
        const date = new Date(Number(value || 0));
        if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "-";
        return date.toLocaleString(currentLanguage === "zh" ? "zh-CN" : "en-US", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      }

      // Keep the API query as the single source of truth for dashboard filters.
      function buildUsageQuery() {
        const params = new URLSearchParams({
          preset: usageFilters.preset,
          recentValue: usageFilters.recentValue,
          bucket: usageFilters.bucket,
          modelProvider: usageFilters.modelProvider,
        });
        if (usageFilters.startDate) params.set("startDate", usageFilters.startDate);
        if (usageFilters.endDate) params.set("endDate", usageFilters.endDate);
        const query = params.toString();
        return query ? "?" + query : "";
      }

      // Render every usage dashboard section from one aggregate payload.
      function renderUsageDashboard(dashboard) {
        usageFilters.preset = dashboard.range?.preset || usageFilters.preset;
        usageFilters.bucket = dashboard.range?.bucket || usageFilters.bucket;
        usageFilters.modelProvider = dashboard.modelProvider || usageFilters.modelProvider;
        syncUsageFilterControls();
        renderUsageRangeLabel(dashboard.range);
        renderUsageSummary(dashboard);
        renderTimelineDistribution(dashboard.timeline);
        renderUsageGroupList(usageProvidersEl, dashboard.byProvider, true);
        updateUsageModelProviderOptions(dashboard);
        renderUsageGroupList(usageModelsEl, dashboard.byModel);
        renderUsageGroupList(usageProjectsEl, dashboard.byCwd);
        renderRecentUsage(dashboard.recent);
      }

      // Reflect filter state in the controls after server-side normalization.
      function syncUsageFilterControls() {
        for (const button of usagePresetButtonsEl.querySelectorAll("button")) {
          button.classList.toggle("active", button.dataset.usagePreset === usageFilters.preset);
        }
        usageRecentValueEl.value = usageFilters.recentValue;
        usageStartDateEl.value = usageFilters.startDate;
        usageEndDateEl.value = usageFilters.endDate;
        usageBucketEl.value = usageFilters.bucket;
      }

      // Render the active range label without affecting the filter controls.
      function renderUsageRangeLabel(range) {
        if (!range || (!range.start && !range.end)) {
          usageRangeLabelEl.textContent = t("usage.all") + " · " + usageBucketLabel(range?.bucket);
          return;
        }
        usageRangeLabelEl.textContent = t("usage.rangeLabel", {
          start: formatUsageRangeDate(range.start),
          end: formatUsageRangeDate(range.end),
          bucket: usageBucketLabel(range.bucket),
        });
      }

      // Render top-level totals as compact cards for quick scanning.
      function renderUsageSummary(dashboard) {
        usageSummaryEl.replaceChildren();
        for (const item of usageSummaryItems(dashboard)) {
          const card = document.createElement("div");
          card.className = "usage-card";
          const label = document.createElement("div");
          label.className = "usage-label";
          label.textContent = item.label;
          const value = document.createElement("div");
          value.className = "usage-value";
          value.textContent = item.value;
          card.append(label, value);
          usageSummaryEl.appendChild(card);
        }
      }

      // Build the localized summary metrics shown at the top of the dashboard.
      function usageSummaryItems(dashboard) {
        return [
          { label: t("usage.requests"), value: formatUsageNumber(dashboard.totalRequests) },
          { label: t("usage.total"), value: formatUsageNumber(dashboard.totals.total) },
          { label: t("usage.input"), value: formatUsageNumber(dashboard.totals.input) },
          { label: t("usage.cached"), value: formatUsageNumber(dashboard.totals.cached) },
          { label: t("usage.output"), value: formatUsageNumber(dashboard.totals.output) },
          { label: t("usage.reasoning"), value: formatUsageNumber(dashboard.totals.reasoning) },
        ];
      }

      // Render the timeline with a real plot area so bar heights match token ratios.
      function renderTimelineDistribution(timeline) {
        usageTimelineEl.replaceChildren();
        hideTimelineTooltip();
        if (!timeline || timeline.length === 0) {
          usageTimelineEl.appendChild(usageEmptyState());
          return;
        }

        const maxTimelineTotal = Math.max(1, ...timeline.map((item) => item.usage.total));
        const frame = document.createElement("div");
        frame.className = "usage-timeline-frame";

        const yAxis = document.createElement("div");
        yAxis.className = "usage-timeline-y-axis";
        yAxis.append(
          createTimelineAxisLabel("usage-timeline-axis-top", timelineAxisLabel(maxTimelineTotal)),
          createTimelineAxisLabel("usage-timeline-axis-zero", "0")
        );

        const plot = document.createElement("div");
        plot.className = "usage-timeline-plot";
        const svg = createTimelineSvg();
        renderTimelineSvgBars(svg, timeline, maxTimelineTotal);
        plot.appendChild(svg);

        const xAxis = document.createElement("div");
        xAxis.className = "usage-timeline-x-axis";
        renderTimelineLabels(xAxis, timeline);

        frame.append(yAxis, plot, xAxis);
        usageTimelineEl.replaceChildren(frame);
      }

      // Show a custom tooltip immediately; native title bubbles are too slow
      // and cannot display provider-colored token breakdowns.
      function showTimelineTooltip(item, event) {
        usageTimelineTooltipEl.replaceChildren(...timelineTooltipContent(item));
        usageTimelineTooltipEl.hidden = false;
        positionTimelineTooltip(event);
      }

      // Keep the tooltip inside the timeline wrapper while following the cursor.
      function positionTimelineTooltip(event) {
        if (usageTimelineTooltipEl.hidden) return;
        const wrapper = usageTimelineTooltipEl.parentElement;
        const wrapperRect = wrapper.getBoundingClientRect();
        const tooltipRect = usageTimelineTooltipEl.getBoundingClientRect();
        const fallbackRect = event.currentTarget?.getBoundingClientRect?.() || wrapperRect;
        const pointerX = typeof event.clientX === "number" ? event.clientX : fallbackRect.left;
        const pointerY = typeof event.clientY === "number" ? event.clientY : fallbackRect.top;
        const maxLeft = Math.max(12, wrapperRect.width - tooltipRect.width - 12);
        const maxTop = Math.max(12, wrapperRect.height - tooltipRect.height - 12);
        const left = Math.min(maxLeft, Math.max(12, pointerX - wrapperRect.left + 14));
        const top = Math.min(maxTop, Math.max(12, pointerY - wrapperRect.top + 14));
        usageTimelineTooltipEl.style.left = left + "px";
        usageTimelineTooltipEl.style.top = top + "px";
      }

      // Hide and clear the timeline tooltip between hovers and data refreshes.
      function hideTimelineTooltip() {
        usageTimelineTooltipEl.hidden = true;
        usageTimelineTooltipEl.replaceChildren();
      }

      // Build a rich tooltip from one timeline bucket without injecting HTML.
      function timelineTooltipContent(item) {
        const title = document.createElement("div");
        title.className = "usage-tooltip-title";
        title.textContent = item.key;
        const metrics = document.createElement("div");
        metrics.className = "usage-tooltip-grid";
        for (const row of timelineTooltipMetricRows(item)) {
          metrics.appendChild(usageTooltipRow(row.label, row.value));
        }

        const providers = document.createElement("div");
        providers.className = "usage-tooltip-providers";
        for (const provider of item.providers || []) {
          providers.appendChild(usageTooltipProviderRow(provider));
        }
        return providers.childElementCount > 0 ? [title, metrics, providers] : [title, metrics];
      }

      // Convert timeline usage fields into localized tooltip rows.
      function timelineTooltipMetricRows(item) {
        return [
          { label: t("usage.total"), value: formatUsageNumber(item.usage.total) },
          { label: t("usage.input"), value: formatUsageNumber(item.usage.input) },
          { label: t("usage.cached"), value: formatUsageNumber(item.usage.cached) },
          { label: t("usage.output"), value: formatUsageNumber(item.usage.output) },
          { label: t("usage.reasoning"), value: formatUsageNumber(item.usage.reasoning) },
          { label: t("usage.requests"), value: formatUsageNumber(item.requests) },
        ];
      }

      // Build one label/value row for the timeline tooltip.
      function usageTooltipRow(labelText, valueText) {
        const row = document.createElement("div");
        row.className = "usage-tooltip-row";
        const label = document.createElement("span");
        label.className = "usage-meta";
        label.textContent = labelText;
        const value = document.createElement("strong");
        value.textContent = valueText;
        row.append(label, value);
        return row;
      }

      // Build one provider row with the same color as timeline segments.
      function usageTooltipProviderRow(provider) {
        const row = document.createElement("div");
        row.className = "usage-tooltip-provider";
        const nameWrap = document.createElement("span");
        nameWrap.className = "usage-tooltip-provider-name";
        const dot = document.createElement("span");
        dot.className = "usage-provider-dot";
        dot.style.background = providerColor(provider.name);
        const name = document.createElement("code");
        name.textContent = provider.name;
        name.title = provider.name;
        const value = document.createElement("span");
        value.className = "usage-meta";
        value.textContent = t("usage.tokenCount", {
          count: formatUsageNumber(provider.usage.total),
        });
        nameWrap.append(dot, name);
        row.append(nameWrap, value);
        return row;
      }

      // Provide keyboard users and assistive tech the same numbers as hover.
      function timelineTooltipPlainText(item) {
        const metrics = timelineTooltipMetricRows(item)
          .map((row) => row.label + ": " + row.value)
          .join(", ");
        const providers = (item.providers || [])
          .map((provider) => provider.name + ": " + formatUsageNumber(provider.usage.total))
          .join(", ");
        return [item.key, metrics, providers].filter(Boolean).join(" · ");
      }

      // Build a timeline SVG that scales bars but leaves labels in normal HTML.
      function createTimelineSvg() {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "usage-timeline-svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        return svg;
      }

      // Draw stacked provider rects for each timeline bucket inside the plot.
      function renderTimelineSvgBars(svg, timeline, maxTimelineTotal) {
        const safeCount = Math.max(1, timeline.length);
        const slotWidth = 100 / safeCount;
        const barGapPercent = Math.min(16, Math.max(0.8, slotWidth * 0.18));
        const barWidthPercent = Math.max(0.5, slotWidth - barGapPercent);

        timeline.forEach((item, index) => {
          const x = index * slotWidth + (slotWidth - barWidthPercent) / 2;
          let cursorY = 100;
          for (const provider of timelineProviders(item)) {
            const rawHeightPercent =
              (Number(provider.usage?.total || 0) / maxTimelineTotal) * 100;
            if (rawHeightPercent <= 0) continue;

            const segmentHeightPercent = Math.min(cursorY, Math.max(0.5, rawHeightPercent));
            cursorY = Math.max(0, cursorY - segmentHeightPercent);
            const segment = document.createElementNS(SVG_NS, "rect");
            segment.setAttribute("class", "usage-timeline-bar-segment");
            segment.setAttribute("x", chartNumber(x));
            segment.setAttribute("y", chartNumber(cursorY));
            segment.setAttribute("width", chartNumber(barWidthPercent));
            segment.setAttribute("height", chartNumber(segmentHeightPercent));
            segment.setAttribute("fill", providerColor(provider.name));
            svg.appendChild(segment);
          }

          const hit = document.createElementNS(SVG_NS, "rect");
          hit.setAttribute("class", "usage-timeline-bar-hit");
          hit.setAttribute("x", chartNumber(index * slotWidth));
          hit.setAttribute("y", "0");
          hit.setAttribute("width", chartNumber(slotWidth));
          hit.setAttribute("height", "100");
          hit.setAttribute("fill", "transparent");
          hit.setAttribute("pointer-events", "all");
          hit.tabIndex = 0;
          hit.setAttribute("aria-label", timelineTooltipPlainText(item));
          hit.addEventListener("pointerenter", (event) => showTimelineTooltip(item, event));
          hit.addEventListener("pointermove", (event) => positionTimelineTooltip(event));
          hit.addEventListener("pointerleave", hideTimelineTooltip);
          hit.addEventListener("focus", (event) => showTimelineTooltip(item, event));
          hit.addEventListener("blur", hideTimelineTooltip);
          svg.appendChild(hit);
        });
      }

      // Reuse item totals when older records do not have provider breakdowns.
      function timelineProviders(item) {
        return item.providers?.length ? item.providers : [{ name: "unknown", usage: item.usage }];
      }

      // Keep SVG numbers short while preserving enough precision for dense charts.
      function chartNumber(value) {
        return String(Math.round(Number(value || 0) * 1000) / 1000);
      }

      // Create one y-axis label in the timeline frame.
      function createTimelineAxisLabel(className, text) {
        const label = document.createElement("span");
        label.className = className;
        label.textContent = text;
        return label;
      }

      // Render a readable subset of x-axis labels below the SVG plot.
      function renderTimelineLabels(axis, timeline) {
        const step = timelineLabelStep(timeline.length);
        timeline.forEach((item, index) => {
          if (index % step !== 0 && index !== timeline.length - 1) return;
          const label = document.createElement("span");
          label.className = "usage-timeline-label";
          label.style.left = ((index + 0.5) / Math.max(1, timeline.length)) * 100 + "%";
          label.textContent = timelineLabel(item.key);
          label.title = item.key;
          axis.appendChild(label);
        });
      }

      // Thin x-axis labels as the number of buckets grows.
      function timelineLabelStep(count) {
        if (count <= 12) return 1;
        if (count <= 45) return Math.ceil(count / 12);
        return Math.ceil(count / 16);
      }

      // Rebuild the model-provider selector from the current filtered dataset.
      function updateUsageModelProviderOptions(dashboard) {
        const options = ["all", ...(dashboard.modelProviderOptions || [])];
        const selected = options.includes(dashboard.modelProvider)
          ? dashboard.modelProvider
          : "all";
        usageFilters.modelProvider = selected;
        usageModelProviderEl.replaceChildren();

        for (const provider of options) {
          const option = document.createElement("option");
          option.value = provider;
          option.textContent = provider === "all" ? t("usage.allProviders") : provider;
          usageModelProviderEl.appendChild(option);
        }
        usageModelProviderEl.value = selected;
      }

      // Render one grouped usage list with proportional bars.
      function renderUsageGroupList(target, groups, colorByProvider = false) {
        target.replaceChildren();
        if (!groups || groups.length === 0) {
          target.appendChild(usageEmptyState());
          return;
        }

        const maxTotal = Math.max(1, groups[0].usage.total);
        for (const group of groups) {
          const color = colorByProvider ? providerColor(group.name) : "";
          target.appendChild(createUsageGroupRow(group, maxTotal, color));
        }
      }

      // Build a single provider/model/project aggregate row.
      function createUsageGroupRow(group, maxTotal, color = "") {
        const row = document.createElement("div");
        row.className = "usage-row";
        row.title = group.name;
        const main = document.createElement("div");
        main.className = "usage-row-main";
        const nameWrap = document.createElement("div");
        nameWrap.className = "usage-row-name";
        if (color) {
          const dot = document.createElement("span");
          dot.className = "usage-provider-dot";
          dot.style.background = color;
          nameWrap.appendChild(dot);
        }
        const name = document.createElement("code");
        name.className = "usage-name";
        name.textContent = group.name;
        name.title = group.name;
        nameWrap.appendChild(name);
        const tokens = document.createElement("span");
        tokens.className = "usage-meta";
        tokens.textContent = t("usage.tokenCount", {
          count: formatUsageNumber(group.usage.total),
        });
        const meta = document.createElement("div");
        meta.className = "usage-meta";
        meta.textContent = t("usage.requestCount", {
          count: formatUsageNumber(group.requests),
        });
        const bar = document.createElement("div");
        bar.className = "usage-bar";
        const fill = document.createElement("span");
        fill.className = "usage-bar-fill";
        fill.style.width = Math.max(4, Math.round((group.usage.total / maxTotal) * 100)) + "%";
        if (color) fill.style.background = color;
        bar.appendChild(fill);
        main.append(nameWrap, tokens);
        row.append(main, meta, bar);
        return row;
      }

      // Render the newest individual usage requests.
      function renderRecentUsage(recent) {
        usageRecentEl.replaceChildren();
        if (!recent || recent.length === 0) {
          usageRecentEl.appendChild(usageEmptyState());
          return;
        }

        for (const event of recent.slice(0, 12)) {
          usageRecentEl.appendChild(createRecentUsageEvent(event));
        }
      }

      // Build one recent request row without injecting HTML strings.
      function createRecentUsageEvent(event) {
        const row = document.createElement("div");
        row.className = "usage-event";
        const head = document.createElement("div");
        head.className = "usage-event-head";
        const name = document.createElement("code");
        name.className = "usage-name";
        name.textContent = event.provider + "@" + event.model;
        name.title = name.textContent;
        const tokens = document.createElement("span");
        tokens.className = "usage-meta";
        tokens.textContent = t("usage.tokenCount", {
          count: formatUsageNumber(event.usage.total),
        });
        const meta = document.createElement("div");
        meta.className = "usage-event-meta";
        meta.textContent = [
          formatUsageDate(event.timestamp),
          event.cwd,
          event.apiSurface,
          event.requestId,
        ]
          .filter(Boolean)
          .join(" · ");
        meta.title = meta.textContent;
        head.append(name, tokens);
        row.append(head, meta);
        return row;
      }

      // Render an empty-state placeholder shared by usage sections.
      function usageEmptyState() {
        const empty = document.createElement("div");
        empty.className = "usage-empty";
        empty.textContent = t("usage.noData");
        return empty;
      }

      // Format numbers with the active UI locale.
      function formatUsageNumber(value) {
        return Number(value || 0).toLocaleString(currentLanguage === "zh" ? "zh-CN" : "en-US");
      }

      // Format the timeline y-axis using compact suffixes like the reference dashboard.
      function timelineAxisLabel(value) {
        const number = Number(value || 0);
        if (number >= 1_000_000_000) return trimAxisNumber(number / 1_000_000_000) + "B";
        if (number >= 1_000_000) return trimAxisNumber(number / 1_000_000) + "M";
        if (number >= 1_000) return trimAxisNumber(number / 1_000) + "K";
        return formatUsageNumber(number);
      }

      // Remove unhelpful trailing zeros from compact axis labels.
      function trimAxisNumber(value) {
        return value.toFixed(2).replace(/\.?0+$/, "");
      }

      // Format timestamps compactly while tolerating old or malformed rows.
      function formatUsageDate(timestamp) {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return timestamp || "";
        return date.toLocaleString(currentLanguage === "zh" ? "zh-CN" : "en-US", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
      }

      // Derive a stable palette index from provider text instead of list order.
      function providerColor(provider) {
        let hash = 0;
        const source = provider || "unknown";
        for (let index = 0; index < source.length; index += 1) {
          hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
        }
        return PROVIDER_COLORS[hash % PROVIDER_COLORS.length];
      }

      // Format range endpoints as dates because the filter is calendar-based.
      function formatUsageRangeDate(timestamp) {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return timestamp || "-";
        return date.toLocaleDateString(currentLanguage === "zh" ? "zh-CN" : "en-US");
      }

      // Use localized bucket names in the compact range summary.
      function usageBucketLabel(bucket) {
        return t("usage.bucket." + (bucket || usageFilters.bucket));
      }

      // Keep dense timeline labels short enough for narrow bar columns.
      function timelineLabel(key) {
        if (!key) return "";
        if (key.length === 10) return key.slice(5);
        return key;
      }

      // Persist default model/provider values.
      document.querySelector("#defaults-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await requestJson("/api/defaults", {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
          });
          setStatus(t("status.defaultsSaved"));
          await loadState();
        } catch (err) {
          setStatus(err.message, true);
        }
      });

      // Persist a new provider or update the selected provider.
      providerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const wasEditing = Boolean(editingProviderId);
        const payload = normalizedProviderPayload(form);
        payload.models = collectProviderModels(payload.defaultModel);
        const endpoint =
          editingProviderSource === "builtin" && editingProviderId
            ? "/api/builtin-providers/" + encodeURIComponent(editingProviderId)
            : "/api/custom-providers";
        try {
          await requestJson(endpoint, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          closeProviderModal();
          resetProviderForm();
          setStatus(wasEditing ? t("status.providerUpdated") : t("status.providerSaved"));
          await loadState();
        } catch (err) {
          setStatus(err.message, true);
        }
      });

      // 保存飞书账号热更新字段，其他 YAML 配置由后端保留。
      feishuConfigFormEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await saveFeishuAccounts();
        } catch (err) {
          setStatus(err.message, true);
        }
      });

      // Create xterm once and keep it mounted for the lifetime of the page.
      function ensureTerminal() {
        if (terminal) return true;
        if (!window.Terminal) {
          renderTerminalStatus("unavailable");
          setStatus(t("terminal.unavailable"), true);
          return false;
        }

        terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: '"SFMono-Regular", Consolas, monospace',
          fontSize: 13,
          theme: {
            background: "#0b0f12",
            foreground: "#edf1f5",
            cursor: "#22a991",
            selectionBackground: "#264b52",
          },
        });

        if (window.FitAddon) {
          terminalFitAddon = new FitAddon.FitAddon();
          terminal.loadAddon(terminalFitAddon);
        }

        terminal.open(terminalMountEl);
        terminal.write("Select a provider/model, then start a claudish session.\\r\\n");
        terminalInputDisposable = terminal.onData((data) => sendTerminalInput(data));
        terminalResizeDisposable = terminal.onResize((size) => sendTerminalResize(size.cols, size.rows));
        fitTerminalSoon();
        return true;
      }

      // Fit xterm after layout changes have landed in the browser.
      function fitTerminalSoon() {
        window.requestAnimationFrame(() => {
          if (!terminal || !terminalFitAddon) return;
          terminalFitAddon.fit();
          sendTerminalResize(terminal.cols, terminal.rows);
        });
      }

      // Send one keyboard/input chunk to the active terminal socket.
      function sendTerminalInput(data) {
        if (!terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) return;
        terminalSocket.send(JSON.stringify({ type: "input", data }));
      }

      // Send the current xterm size to the backend terminal session.
      function sendTerminalResize(cols, rows) {
        if (!terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) return;
        terminalSocket.send(JSON.stringify({ type: "resize", cols, rows }));
      }

      // Build a websocket URL that preserves localhost host/port automatically.
      function terminalSocketUrl() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const params = new URLSearchParams({
          provider: chatProviderEl.value,
          model: chatModelEl.value,
          cols: String(terminal?.cols || 100),
          rows: String(terminal?.rows || 30),
        });
        return protocol + "//" + window.location.host + "/api/terminal?" + params.toString();
      }

      // Start or restart a real claudish session behind the browser terminal.
      async function startTerminalSession() {
        if (!ensureTerminal()) return;
        await restartTerminalSession();
      }

      // Close any existing terminal before opening a fresh provider/model session.
      async function restartTerminalSession() {
        const isRestarting = Boolean(terminalSocket);
        if (isRestarting) {
          renderTerminalStatus("restarting");
          await closeTerminalSocket(false);
        }
        terminal.clear();
        renderTerminalStatus("connecting");
        terminalStartEl.disabled = true;
        terminalStopEl.disabled = false;

        try {
          const socket = new WebSocket(terminalSocketUrl());
          terminalSocket = socket;
          socket.binaryType = "arraybuffer";
          socket.onopen = () => {
            if (terminalSocket !== socket) return;
            renderTerminalStatus("connected");
            setStatus(t("status.terminalStarted"));
            fitTerminalSoon();
            terminal.focus();
          };
          socket.onmessage = (event) => {
            if (terminalSocket !== socket) return;
            if (event.data instanceof ArrayBuffer) {
              terminal.write(new Uint8Array(event.data));
            } else {
              terminal.write(String(event.data));
            }
          };
          socket.onerror = () => {
            if (terminalSocket !== socket) return;
            renderTerminalStatus("closed");
            setStatus(t("error.terminalStart"), true);
          };
          socket.onclose = () => finalizeTerminalClose(socket, false);
        } catch (err) {
          terminalSocket = null;
          terminalStartEl.disabled = false;
          terminalStopEl.disabled = true;
          renderTerminalStatus("closed");
          setStatus(err.message || t("error.terminalStart"), true);
        }
      }

      // Stop the current claudish terminal session from the browser side.
      async function stopTerminalSession(showStatus = true) {
        await closeTerminalSocket(showStatus);
      }

      // Close the active WebSocket and resolve only after its close callback runs.
      function closeTerminalSocket(showStatus = true) {
        const socket = terminalSocket;
        if (!socket) return Promise.resolve();

        return new Promise((resolve) => {
          socket.onclose = () => {
            finalizeTerminalClose(socket, showStatus);
            resolve();
          };
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "close" }));
          }
          if (socket.readyState === WebSocket.CLOSED) {
            finalizeTerminalClose(socket, showStatus);
            resolve();
          } else {
            socket.close();
          }
        });
      }

      // Ignore late close events from old sockets after a restart opened a new one.
      function finalizeTerminalClose(socket, showStatus) {
        if (terminalSocket !== socket) return;
        terminalSocket = null;
        terminalStartEl.disabled = false;
        terminalStopEl.disabled = true;
        renderTerminalStatus("closed");
        if (showStatus) setStatus(t("status.terminalStopped"));
      }

      // Wire tab buttons.
      for (const button of document.querySelectorAll(".tab")) {
        button.addEventListener("click", () => setActiveTab(button.dataset.tab));
      }

      // Wire theme and provider form utility buttons.
      document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
      languageToggleEl.addEventListener("click", toggleLanguage);
      defaultProviderEl.addEventListener("input", refreshModelCombosForProvider);
      chatProviderEl.addEventListener("input", refreshModelCombosForProvider);
      providerAddButton.addEventListener("click", newProvider);
      providerKeyToggle.addEventListener("click", toggleProviderKeyVisibility);
      providerLoginButton.addEventListener("click", loginBuiltinProvider);
      providerModelAddButton.addEventListener("click", () => addProviderModel());
      providerModelInputEl.addEventListener("input", renderProviderModelList);
      providerModelInputEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        addProviderModel();
      });
      feishuAccountAddEl.addEventListener("click", addFeishuAccount);
      feishuEditAllEl.addEventListener("click", () => setAllFeishuAccountsEditing(true));
      feishuCancelAllEl.addEventListener("click", () => {
        cancelFeishuAllEdits().catch((err) => setStatus(err.message, true));
      });
      feishuSaveAllEl.addEventListener("click", () => {
        saveFeishuAccounts().catch((err) => setStatus(err.message, true));
      });
      providerCancelButton.addEventListener("click", () => {
        closeProviderModal();
        resetProviderForm();
      });
      providerCloseButton.addEventListener("click", () => {
        closeProviderModal();
        resetProviderForm();
      });
      providerModal.addEventListener("click", (event) => {
        if (event.target === providerModal) {
          closeProviderModal();
          resetProviderForm();
        }
      });
      feishuSessionDrawerCloseEl.addEventListener("click", closeFeishuSessionDrawer);
      feishuSessionDrawerBackdropEl.addEventListener("click", closeFeishuSessionDrawer);
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".combo")) closeAllCombos();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          if (!feishuSessionDrawerEl.hidden) {
            closeFeishuSessionDrawer();
          }
          closeAllCombos();
          if (!providerModal.hidden) {
            closeProviderModal();
            resetProviderForm();
          }
        }
      });

      // Wire terminal controls and keep the PTY view fitted to the browser.
      terminalStartEl.addEventListener("click", startTerminalSession);
      terminalStopEl.addEventListener("click", () => stopTerminalSession(true));
      channelsRefreshEl.addEventListener("click", () => {
        loadChannels().catch((err) => setStatus(err.message, true));
      });

      // Wire usage filters so every change refreshes the same dashboard API.
      usagePresetButtonsEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-usage-preset]");
        if (!button) return;
        usageFilters.preset = button.dataset.usagePreset;
        syncUsageFilterControls();
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageRecentValueEl.addEventListener("change", () => {
        usageFilters.preset = "recent";
        usageFilters.recentValue = usageRecentValueEl.value;
        syncUsageFilterControls();
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageStartDateEl.addEventListener("change", () => {
        usageFilters.preset = "custom";
        usageFilters.startDate = usageStartDateEl.value;
        syncUsageFilterControls();
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageEndDateEl.addEventListener("change", () => {
        usageFilters.preset = "custom";
        usageFilters.endDate = usageEndDateEl.value;
        syncUsageFilterControls();
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageBucketEl.addEventListener("change", () => {
        usageFilters.bucket = usageBucketEl.value;
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageModelProviderEl.addEventListener("change", () => {
        usageFilters.modelProvider = usageModelProviderEl.value;
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      usageRefreshEl.addEventListener("click", () => {
        loadUsageDashboard().catch((err) => setStatus(err.message, true));
      });
      window.addEventListener("resize", fitTerminalSoon);
      window.addEventListener("beforeunload", () => {
        if (channelsRefreshTimer) clearInterval(channelsRefreshTimer);
        // Close the local claudish process when the browser tab goes away.
        stopTerminalSession(false);
        terminalInputDisposable?.dispose();
        terminalResizeDisposable?.dispose();
      });

      // Initialize theme before fetching state to avoid a bright flash.
      initializeComboboxes();
      updateComboOptions("formats", ["openai", "anthropic", "gemini"]);
      applyTheme(localStorage.getItem("claudish-theme") || "dark");
      applyLanguage(detectInitialLanguage());
      loadState().catch((err) => setStatus(err.message, true));
      loadFeishuConfig().catch((err) => setStatus(err.message, true));
      loadUsageDashboard().catch((err) => setStatus(err.message, true));
      loadChannels().catch((err) => setStatus(err.message, true));
    </script>
  </body>
</html>`;
}
