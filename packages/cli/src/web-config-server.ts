/**
 * Local Web UI for editing ~/.claudish/config.json.
 *
 * This server is intentionally localhost-only and does not expose proxy
 * controls. It edits the same shared config helpers used by the terminal TUI.
 */

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
import {
  type WebChatRequest,
  type WebChatService,
  createProxyBackedChatService,
} from "./web-chat-service.js";
import {
  type CreatePythonTerminalSessionOptions,
  type WebTerminalSession,
  createPythonTerminalSession,
  parseTerminalSocketMessage,
} from "./web-terminal-service.js";
import { getUsageDashboard, resolveClaudishProjectRoot } from "./web-usage-service.js";

type TerminalSessionFactory = (options: CreatePythonTerminalSessionOptions) => WebTerminalSession;
type OAuthLoginHandler = (providerId: string) => Promise<void>;

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
  chatService?: WebChatService;
  oauthLogin?: OAuthLoginHandler;
  terminalSessionFactory?: TerminalSessionFactory;
  terminalWorkingDirectory?: string;
  usageProjectRoot?: string;
}

export interface ConfigWebRequestOptions {
  chatService?: WebChatService;
  oauthLogin?: OAuthLoginHandler;
  usageProjectRoot?: string;
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
 * Default chat service is lazy, so importing the Web UI does not start a proxy.
 */
const defaultChatService = createProxyBackedChatService();

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

  if (url.pathname === "/api/chat") {
    return handleChatPost(request, options.chatService ?? defaultChatService);
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
  const chatService = options.chatService ?? createProxyBackedChatService();
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
        chatService,
        oauthLogin: options.oauthLogin,
        usageProjectRoot,
      });
    },
    websocket: createTerminalWebSocketHandler(terminalSessionFactory),
  });

  console.log(`Claudish Config Web UI: http://127.0.0.1:${server.port}/`);
  console.log("Press Ctrl+C to stop.");
  return server;
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
 * Stream a real chat request through the configured chat service.
 */
async function handleChatPost(request: Request, chatService: WebChatService): Promise<Response> {
  const body = await readJson<WebChatRequest>(request);
  return ensureEventStreamResponse(await chatService.streamChat(body));
}

/**
 * Ensure browser chat fetches can treat every chat response as an SSE stream.
 */
function ensureEventStreamResponse(response: Response): Response {
  if (response.headers.get("content-type")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        color: var(--text);
        padding: 9px 10px;
        font: inherit;
      }
      input {
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
        max-height: 150px;
        overflow: auto;
      }
      .provider-model-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
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
        width: min(560px, 100%);
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
      .usage-timeline {
        display: grid;
        align-items: end;
        gap: 10px;
        min-height: 260px;
        min-width: 0;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 12px;
        background: var(--field);
      }
      .usage-timeline-column {
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: end;
        min-width: 0;
      }
      .usage-timeline-bar {
        display: flex;
        flex-direction: column-reverse;
        align-items: end;
        width: 100%;
        min-height: 190px;
        border-radius: 4px 4px 0 0;
        overflow: hidden;
        background: var(--line);
      }
      .usage-timeline-segment {
        display: block;
        width: 100%;
        min-height: 2px;
      }
      .usage-timeline-label {
        overflow: hidden;
        color: var(--muted);
        font-size: 10px;
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
        .terminal-toolbar,
        .usage-filter,
        .usage-main-grid,
        .usage-stacked-grid,
        .usage-summary {
          grid-template-columns: 1fr;
        }
        .usage-panel-head {
          align-items: stretch;
          flex-direction: column;
        }
        .usage-model-filter {
          width: 100%;
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
              <div class="usage-timeline" id="usage-timeline"></div>
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
    <div class="modal-backdrop" id="provider-modal" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="provider-form-title">
        <div class="modal-head">
          <h2 id="provider-form-title" data-i18n="providerModal.title">Custom Provider</h2>
          <button class="ghost" id="provider-close" type="button" aria-label="Close provider editor" data-i18n="common.close" data-i18n-aria-label="aria.closeProviderEditor">Close</button>
        </div>
        <div class="modal-body">
          <form id="provider-form">
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
              <span class="field-help" data-i18n="providerModal.modelsHelp">One model per line. The default model will be added automatically.</span>
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
      let editingProviderId = "";
      let editingProviderSource = "";
      let providerModelDraft = [];
      let terminal = null;
      let terminalFitAddon = null;
      let terminalSocket = null;
      let terminalInputDisposable = null;
      let terminalResizeDisposable = null;
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
      const CODEX_OAUTH_TYPE_LABEL = "Codex-Oauth";
      const comboStates = new Map();

      // UI translations stay client-side so the config API remains unchanged.
      const translations = {
        en: {
          "app.title": "Claudish Config",
          "tabs.config": "Config",
          "tabs.providers": "Providers",
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
          "providers.current": "Current Providers",
          "providers.title": "Providers",
          "providers.add": "Add Provider",
          "providers.id": "ID",
          "providers.type": "Type",
          "providers.modelCount": "Models",
          "providers.defaultModel": "Default model",
          "providers.actions": "Actions",
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
          "terminal.stop": "Stop",
          "terminal.default": "Default: {provider} / {model}",
          "terminal.disconnected": "Disconnected.",
          "terminal.connecting": "Starting claudish...",
          "terminal.connected": "Connected.",
          "terminal.closed": "Chat session closed.",
          "terminal.unavailable": "Chat terminal library failed to load.",
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
          "status.oauthLoginStarted": "OAuth login started...",
          "status.oauthLoginDone": "OAuth login completed.",
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
        },
        zh: {
          "app.title": "Claudish 配置",
          "tabs.config": "配置",
          "tabs.providers": "Provider",
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
          "providers.current": "当前 Provider",
          "providers.title": "Provider",
          "providers.add": "添加 Provider",
          "providers.id": "ID",
          "providers.type": "类型",
          "providers.modelCount": "模型数",
          "providers.defaultModel": "默认模型",
          "providers.actions": "操作",
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
          "terminal.stop": "停止",
          "terminal.default": "默认：{provider} / {model}",
          "terminal.disconnected": "未连接。",
          "terminal.connecting": "正在启动 claudish...",
          "terminal.connected": "已连接。",
          "terminal.closed": "聊天会话已关闭。",
          "terminal.unavailable": "聊天终端库加载失败。",
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
          "status.oauthLoginStarted": "正在启动 OAuth 登录...",
          "status.oauthLoginDone": "OAuth 登录完成。",
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
      const chatProviderEl = document.querySelector("#chat-provider");
      const chatModelEl = document.querySelector("#chat-model");
      const terminalStartEl = document.querySelector("#terminal-start");
      const terminalStopEl = document.querySelector("#terminal-stop");
      const terminalStatusEl = document.querySelector("#terminal-status");
      const terminalMountEl = document.querySelector("#terminal");
      const usageRefreshEl = document.querySelector("#usage-refresh");
      const usagePresetButtonsEl = document.querySelector("#usage-preset-buttons");
      const usageRecentValueEl = document.querySelector("#usage-recent-value");
      const usageStartDateEl = document.querySelector("#usage-start-date");
      const usageEndDateEl = document.querySelector("#usage-end-date");
      const usageBucketEl = document.querySelector("#usage-bucket");
      const usageRangeLabelEl = document.querySelector("#usage-range-label");
      const usageSummaryEl = document.querySelector("#usage-summary");
      const usageTimelineEl = document.querySelector("#usage-timeline");
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
        renderEffectiveDefaults(lastEditorState);
        renderTerminalStatus(terminalSocket ? "connected" : "disconnected");
        if (usageState) renderUsageDashboard(usageState);
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
          connected: "terminal.connected",
          closed: "terminal.closed",
          unavailable: "terminal.unavailable",
        };
        terminalStatusEl.textContent = t(keyByState[state] || "terminal.disconnected");
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
        if (tabName === "chat") fitTerminalSoon();
        if (tabName === "usage" && !usageState) {
          loadUsageDashboard().catch((err) => setStatus(err.message, true));
        }
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
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost provider-model-remove";
        remove.textContent = "x";
        remove.setAttribute("aria-label", t("aria.removeProviderModel") + ": " + model);
        remove.setAttribute("title", t("providerModal.removeModel"));
        remove.addEventListener("click", () => removeProviderModel(model));
        row.append(code, remove);
        return row;
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
        row.appendChild(textCell(providerModelCount(provider)));
        row.appendChild(codeCell(provider.defaultModel || "-"));
        row.appendChild(editable ? providerActions(provider) : textCell(""));
        return row;
      }

      // Show provider capacity without implying one provider maps to one model.
      function providerModelCount(provider) {
        const count = provider.models?.length || (provider.defaultModel ? 1 : 0);
        return currentLanguage === "zh" ? count + " 个模型" : count + " models";
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
        providerKeyEl.value = "";
        providerKeyEl.placeholder = t("providerModal.keepKey");
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
        providerKeyEl.placeholder = "sk-... or $" + "{ENV_VAR}";
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
          if (editingProviderId && !providerKeyEl.value) {
            const secret = await requestJson(
              "/api/custom-providers/" + encodeURIComponent(editingProviderId) + "/secret"
            );
            providerKeyEl.value = secret.apiKey || "";
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

      // Fetch the local Claudish usage aggregate and render the dashboard.
      async function loadUsageDashboard() {
        const dashboard = await requestJson("/api/usage" + buildUsageQuery());
        usageState = dashboard;
        renderUsageDashboard(dashboard);
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

      // Render the timeline as a fixed-height bar chart that cannot widen cards.
      function renderTimelineDistribution(timeline) {
        usageTimelineEl.replaceChildren();
        usageTimelineEl.style.gridTemplateColumns = "";
        if (!timeline || timeline.length === 0) {
          usageTimelineEl.appendChild(usageEmptyState());
          return;
        }

        usageTimelineEl.style.gridTemplateColumns = timelineGridColumns(timeline.length);
        const maxTotal = Math.max(1, ...timeline.map((item) => item.usage.total));
        for (const item of timeline) {
          const column = document.createElement("div");
          column.className = "usage-timeline-column";
          column.title = item.key + " · " + formatUsageNumber(item.usage.total) + " tokens";

          const bar = document.createElement("div");
          bar.className = "usage-timeline-bar";
          bar.style.height = Math.max(6, Math.round((item.usage.total / maxTotal) * 100)) + "%";
          renderTimelineSegments(bar, item);

          const label = document.createElement("span");
          label.className = "usage-timeline-label";
          label.textContent = timelineLabel(item.key);
          column.append(bar, label);
          usageTimelineEl.appendChild(column);
        }
      }

      // Let sparse timelines fill the chart while dense timelines remain readable.
      function timelineGridColumns(count) {
        const safeCount = Math.max(1, Number(count) || 1);
        const minWidth = safeCount > 45 ? "18px" : "0";
        return "repeat(" + safeCount + ", minmax(" + minWidth + ", 1fr))";
      }

      // Fill one timeline bar with provider-colored proportional segments.
      function renderTimelineSegments(bar, item) {
        const providers = item.providers?.length
          ? item.providers
          : [{ name: "unknown", usage: item.usage }];
        for (const provider of providers) {
          const segment = document.createElement("span");
          segment.className = "usage-timeline-segment";
          segment.style.height =
            Math.max(3, Math.round((provider.usage.total / Math.max(1, item.usage.total)) * 100)) +
            "%";
          segment.style.background = providerColor(provider.name);
          segment.title =
            provider.name + " · " + formatUsageNumber(provider.usage.total) + " tokens";
          bar.appendChild(segment);
        }
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
        const payload = Object.fromEntries(new FormData(form));
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

      // Start a real claudish session behind the browser terminal.
      function startTerminalSession() {
        if (!ensureTerminal()) return;
        stopTerminalSession(false);
        terminal.clear();
        renderTerminalStatus("connecting");
        terminalStartEl.disabled = true;
        terminalStopEl.disabled = false;

        try {
          terminalSocket = new WebSocket(terminalSocketUrl());
          terminalSocket.binaryType = "arraybuffer";
          terminalSocket.onopen = () => {
            renderTerminalStatus("connected");
            setStatus(t("status.terminalStarted"));
            fitTerminalSoon();
            terminal.focus();
          };
          terminalSocket.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              terminal.write(new Uint8Array(event.data));
            } else {
              terminal.write(String(event.data));
            }
          };
          terminalSocket.onerror = () => {
            renderTerminalStatus("closed");
            setStatus(t("error.terminalStart"), true);
          };
          terminalSocket.onclose = () => {
            terminalSocket = null;
            terminalStartEl.disabled = false;
            terminalStopEl.disabled = true;
            renderTerminalStatus("closed");
          };
        } catch (err) {
          terminalSocket = null;
          terminalStartEl.disabled = false;
          terminalStopEl.disabled = true;
          renderTerminalStatus("closed");
          setStatus(err.message || t("error.terminalStart"), true);
        }
      }

      // Stop the current claudish terminal session from the browser side.
      function stopTerminalSession(showStatus = true) {
        if (!terminalSocket) return;
        if (terminalSocket.readyState === WebSocket.OPEN) {
          terminalSocket.send(JSON.stringify({ type: "close" }));
        }
        terminalSocket.close();
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
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".combo")) closeAllCombos();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
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
      loadUsageDashboard().catch((err) => setStatus(err.message, true));
    </script>
  </body>
</html>`;
}
