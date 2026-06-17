/**
 * Local Web UI for editing ~/.claudish/config.json.
 *
 * This server is intentionally localhost-only and does not expose proxy
 * controls. It edits the same shared config helpers used by the terminal TUI.
 */

import {
  type CustomProviderFormat,
  deleteCustomProvider,
  getConfigEditorState,
  getCustomProviderSecret,
  saveGeneralDefaults,
  saveSimpleCustomProvider,
} from "./config-editor.js";
import {
  type WebChatRequest,
  type WebChatService,
  createProxyBackedChatService,
} from "./web-chat-service.js";

export interface ConfigWebServerOptions {
  port?: number;
  chatService?: WebChatService;
}

export interface ConfigWebRequestOptions {
  chatService?: WebChatService;
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
    return handleGetRequest(url);
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
function handleGetRequest(url: URL): Response {
  if (url.pathname === "/") {
    return htmlResponse(renderConfigPage());
  }

  if (url.pathname === "/api/config") {
    return jsonResponse(getPublicEditorState());
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

  if (url.pathname === "/api/chat") {
    return handleChatPost(request, options.chatService ?? defaultChatService);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/**
 * Start the localhost-only Web UI server.
 */
export function startConfigWebServer(
  options: ConfigWebServerOptions = {}
): ReturnType<typeof Bun.serve> {
  const chatService = options.chatService ?? createProxyBackedChatService();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch: (request) => handleConfigWebRequest(request, { chatService }),
  });

  console.log(`Claudish Config Web UI: http://127.0.0.1:${server.port}/`);
  console.log("Press Ctrl+C to stop.");
  return server;
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
  }>(request);
  saveSimpleCustomProvider({
    providerId: body.providerId ?? "",
    format: body.format ?? "openai",
    baseUrl: body.baseUrl ?? "",
    apiKey: body.apiKey ?? "",
    defaultModel: body.defaultModel ?? "",
  });
  return jsonResponse(getPublicEditorState());
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
        max-width: 1180px;
        margin: 0 auto;
        padding: 18px;
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
        grid-template-columns: minmax(320px, 420px) 1fr;
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
        grid-template-columns: minmax(130px, 1fr) 110px minmax(140px, 1fr) 156px;
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
      .chat-shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 12px;
        height: 100%;
        min-height: 0;
      }
      .chat-toolbar {
        display: grid;
        grid-template-columns: minmax(170px, 220px) minmax(180px, 1fr) auto minmax(220px, auto);
        gap: 12px;
        align-items: end;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--line);
      }
      .chat-tool {
        display: grid;
        gap: 6px;
      }
      .field-label {
        color: var(--muted);
        font-size: 12px;
      }
      .chat-meta {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px 12px;
        min-width: 0;
      }
      .chat-window {
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        gap: 12px;
      }
      .messages {
        min-height: 0;
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--field);
        padding: 12px;
      }
      .chat-empty {
        min-height: 100%;
        display: grid;
        place-content: center;
        gap: 6px;
        color: var(--muted);
        text-align: center;
      }
      /* Keep the empty prompt fully removed once a transcript exists. */
      .chat-empty[hidden] {
        display: none;
      }
      .chat-empty strong {
        color: var(--text);
        font-size: 15px;
      }
      .message {
        max-width: min(78%, 760px);
        margin-bottom: 10px;
        padding: 10px 12px;
        border-radius: 8px;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
      }
      .message.user {
        margin-left: auto;
        background: var(--accent);
        color: #ffffff;
      }
      .message.assistant {
        background: var(--panel-2);
        border: 1px solid var(--line);
      }
      .chat-composer {
        display: block;
      }
      .composer-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: end;
      }
      .composer-row textarea {
        min-height: 58px;
        max-height: 160px;
      }
      .composer-actions {
        display: grid;
        gap: 8px;
      }
      .composer-actions button {
        min-width: 72px;
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
        .chat-toolbar,
        .composer-row {
          grid-template-columns: 1fr;
        }
        .chat-meta {
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
        <button class="tab active" data-tab="config" type="button" data-i18n="tabs.config">Config</button>
        <button class="tab" data-tab="providers" type="button" data-i18n="tabs.providers">Providers</button>
        <button class="tab" data-tab="chat" type="button" data-i18n="tabs.chat">Chat</button>
      </nav>

      <section class="panel active" id="panel-config">
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
        <section class="chat-shell">
          <div class="chat-toolbar" id="chat-settings">
            <label class="chat-tool">
              <span class="field-label" data-i18n="chat.provider">Provider</span>
                <div class="combo" data-combo="providers">
                  <input id="chat-provider" placeholder="openrouter" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show provider options" data-i18n-aria-label="aria.showProviderOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
            </label>
            <label class="chat-tool">
              <span class="field-label" data-i18n="chat.model">Model</span>
                <div class="combo" data-combo="models">
                  <input id="chat-model" placeholder="gpt-5.5" autocomplete="off" />
                  <button class="combo-toggle" type="button" aria-label="Show model options" data-i18n-aria-label="aria.showModelOptions"></button>
                  <div class="combo-menu" role="listbox"></div>
                </div>
            </label>
            <button class="ghost" id="chat-clear" type="button" data-i18n="chat.clear">Clear Chat</button>
            <div class="chat-meta">
              <div class="source" id="chat-effective"></div>
              <div class="source" id="chat-usage" data-i18n="chat.usage.none">Usage: no chat yet.</div>
            </div>
          </div>
          <div class="chat-window">
            <div class="messages" id="messages">
              <div class="chat-empty" id="chat-empty">
                <strong data-i18n="chat.emptyTitle">Start a conversation</strong>
                <span data-i18n="chat.emptyBody">Choose a provider and model, then send a message.</span>
              </div>
            </div>
            <form class="chat-composer" id="chat-form">
              <label class="sr-only" for="chat-input" data-i18n="chat.message">Message</label>
              <div class="composer-row">
                <textarea id="chat-input" placeholder="Ask something" data-i18n-placeholder="chat.inputPlaceholder"></textarea>
                <div class="composer-actions">
                  <button id="chat-send" type="submit" data-i18n="chat.send">Send</button>
                  <button class="ghost" id="chat-stop" type="button" disabled data-i18n="chat.stop">Stop</button>
                </div>
              </div>
            </form>
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
            <label>
              <span data-i18n="providerModal.compatibleType">Compatible type</span>
              <div class="combo" data-combo="formats">
                <input id="provider-format" name="format" value="openai" autocomplete="off" readonly />
                <button class="combo-toggle" type="button" aria-label="Show compatible types" data-i18n-aria-label="aria.showCompatibleTypes"></button>
                <div class="combo-menu" role="listbox"></div>
              </div>
            </label>
            <label>
              <span data-i18n="providerModal.baseUrl">Base URL</span>
              <input id="provider-url" name="baseUrl" placeholder="https://api.example.com/v1" required />
            </label>
            <label>
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
            <div class="modal-actions">
              <button class="ghost" id="provider-cancel" type="button" data-i18n="common.cancel">Cancel</button>
              <button type="submit" data-i18n="providerModal.save">Save Provider</button>
            </div>
          </form>
        </div>
      </div>
    </div>
    <script>
      // Keep browser-side state tiny and derived from the JSON API.
      let currentState = null;
      let editingProviderId = "";
      let chatMessages = [];
      let chatAbortController = null;
      let currentLanguage = "en";
      let lastEditorState = null;
      let lastChatUsage = null;
      let chatUsageState = "none";
      const comboStates = new Map();

      // UI translations stay client-side so the config API remains unchanged.
      const translations = {
        en: {
          "app.title": "Claudish Config",
          "tabs.config": "Config",
          "tabs.providers": "Providers",
          "tabs.chat": "Chat",
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
          "providerModal.save": "Save Provider",
          "providerModal.keepKey": "Leave blank to keep saved key",
          "common.cancel": "Cancel",
          "common.close": "Close",
          "combo.noMatches": "No matches",
          "chat.provider": "Provider",
          "chat.model": "Model",
          "chat.clear": "Clear Chat",
          "chat.default": "Default: {provider} / {model}",
          "chat.emptyTitle": "Start a conversation",
          "chat.emptyBody": "Choose a provider and model, then send a message.",
          "chat.message": "Message",
          "chat.inputPlaceholder": "Ask something",
          "chat.send": "Send",
          "chat.stop": "Stop",
          "chat.usage.none": "Usage: no chat yet.",
          "chat.usage.waiting": "Usage: waiting for provider response...",
          "chat.usage.unavailable": "Usage: provider did not return token usage.",
          "chat.usage.label": "Usage",
          "chat.usage.total": "total",
          "chat.usage.input": "input",
          "chat.usage.output": "output",
          "status.defaultsSaved": "Defaults saved.",
          "status.providerDeleted": "Provider deleted.",
          "status.providerUpdated": "Provider updated.",
          "status.providerSaved": "Provider saved.",
          "status.sending": "Sending...",
          "status.chatComplete": "Chat complete.",
          "status.chatCleared": "Chat cleared.",
          "status.stopped": "Stopped.",
          "error.chatStreamUnavailable": "Chat stream is not available.",
          "aria.showModelOptions": "Show model options",
          "aria.showProviderOptions": "Show provider options",
          "aria.showCompatibleTypes": "Show compatible types",
          "aria.showApiKey": "Show API key",
          "aria.hideApiKey": "Hide API key",
          "aria.closeProviderEditor": "Close provider editor",
        },
        zh: {
          "app.title": "Claudish 配置",
          "tabs.config": "配置",
          "tabs.providers": "Provider",
          "tabs.chat": "聊天",
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
          "providerModal.save": "保存 Provider",
          "providerModal.keepKey": "留空以保留已保存的 key",
          "common.cancel": "取消",
          "common.close": "关闭",
          "combo.noMatches": "没有匹配项",
          "chat.provider": "Provider",
          "chat.model": "模型",
          "chat.clear": "清空聊天",
          "chat.default": "默认：{provider} / {model}",
          "chat.emptyTitle": "开始对话",
          "chat.emptyBody": "选择 provider 和模型，然后发送消息。",
          "chat.message": "消息",
          "chat.inputPlaceholder": "输入消息",
          "chat.send": "发送",
          "chat.stop": "停止",
          "chat.usage.none": "用量：还没有对话。",
          "chat.usage.waiting": "用量：等待 provider 返回...",
          "chat.usage.unavailable": "用量：provider 没有返回 token 用量。",
          "chat.usage.label": "用量",
          "chat.usage.total": "总计",
          "chat.usage.input": "输入",
          "chat.usage.output": "输出",
          "status.defaultsSaved": "默认设置已保存。",
          "status.providerDeleted": "Provider 已删除。",
          "status.providerUpdated": "Provider 已更新。",
          "status.providerSaved": "Provider 已保存。",
          "status.sending": "发送中...",
          "status.chatComplete": "对话完成。",
          "status.chatCleared": "聊天已清空。",
          "status.stopped": "已停止。",
          "error.chatStreamUnavailable": "聊天流不可用。",
          "aria.showModelOptions": "显示模型选项",
          "aria.showProviderOptions": "显示 Provider 选项",
          "aria.showCompatibleTypes": "显示兼容类型",
          "aria.showApiKey": "显示 API key",
          "aria.hideApiKey": "隐藏 API key",
          "aria.closeProviderEditor": "关闭 Provider 编辑器",
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
      const providerKeyEl = document.querySelector("#provider-key");
      const providerKeyToggle = document.querySelector("#provider-key-toggle");
      const chatProviderEl = document.querySelector("#chat-provider");
      const chatModelEl = document.querySelector("#chat-model");
      const messagesEl = document.querySelector("#messages");
      const chatEmptyEl = document.querySelector("#chat-empty");
      const chatInputEl = document.querySelector("#chat-input");
      const chatSendEl = document.querySelector("#chat-send");
      const chatStopEl = document.querySelector("#chat-stop");
      const chatUsageEl = document.querySelector("#chat-usage");

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

        updateLanguageButton();
        updateThemeButton(document.documentElement.dataset.theme || "dark");
        updateProviderModalTitle();
        renderEffectiveDefaults(lastEditorState);
        renderChatUsageState();
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

      // Format compact token counts without depending on any external library.
      function formatTokenCount(value) {
        const number = Number(value || 0);
        return new Intl.NumberFormat().format(Number.isFinite(number) ? number : 0);
      }

      // Render the latest provider-returned chat usage in the settings column.
      function renderChatUsage(usage) {
        if (!usage) {
          lastChatUsage = null;
          chatUsageState = "unavailable";
          renderChatUsageState();
          return;
        }

        lastChatUsage = usage;
        chatUsageState = "actual";
        renderChatUsageState();
      }

      // Re-render usage text whenever usage data or language changes.
      function renderChatUsageState() {
        if (chatUsageState === "none") {
          chatUsageEl.textContent = t("chat.usage.none");
          return;
        }
        if (chatUsageState === "waiting") {
          chatUsageEl.textContent = t("chat.usage.waiting");
          return;
        }
        if (!lastChatUsage) {
          chatUsageEl.textContent = t("chat.usage.unavailable");
          return;
        }

        const usage = lastChatUsage;
        const input = Number(usage.input_tokens || 0);
        const output = Number(usage.output_tokens || 0);
        const total = input + output;
        chatUsageEl.textContent =
          t("chat.usage.label") +
          ": " +
          (chatProviderEl.value || "-") +
          " / " +
          (chatModelEl.value || "-") +
          " · " +
          t("chat.usage.total") +
          " " +
          formatTokenCount(total) +
          " · " +
          t("chat.usage.input") +
          " " +
          formatTokenCount(input) +
          " · " +
          t("chat.usage.output") +
          " " +
          formatTokenCount(output);
      }

      // Keep the empty state node in the transcript so language changes can update it.
      function showChatEmptyState() {
        messagesEl.replaceChildren(chatEmptyEl);
        chatEmptyEl.hidden = false;
      }

      // Hide the empty state once real messages are present.
      function hideChatEmptyState() {
        chatEmptyEl.hidden = true;
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
        const type = provider.kind === "simple" ? provider.format : provider.transport || provider.kind;
        row.appendChild(codeCell(provider.id));
        row.appendChild(textCell(type || "-"));
        row.appendChild(codeCell(provider.defaultModel || "-"));
        row.appendChild(editable ? providerActions(provider) : textCell(""));
        return row;
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
        updateProviderModalTitle();
        document.querySelector("#provider-id").value = provider.id;
        document.querySelector("#provider-format").value = provider.format || "openai";
        document.querySelector("#provider-url").value = provider.baseUrl || "";
        resetProviderKeyVisibility();
        providerKeyEl.value = "";
        providerKeyEl.placeholder = t("providerModal.keepKey");
        document.querySelector("#provider-model").value = provider.defaultModel || "";
        openProviderModal();
      }

      // Reset the provider form back to create mode.
      function resetProviderForm() {
        editingProviderId = "";
        updateProviderModalTitle();
        providerForm.reset();
        document.querySelector("#provider-format").value = "openai";
        resetProviderKeyVisibility();
        providerKeyEl.placeholder = "sk-... or $" + "{ENV_VAR}";
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

      // Open the provider modal for either create or edit mode.
      function openProviderModal() {
        providerModal.hidden = false;
        document.body.classList.add("modal-open");
        document.querySelector("#provider-id").focus();
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
        document.querySelector("#chat-effective").textContent = t("chat.default", {
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
        try {
          await requestJson("/api/custom-providers", {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
          });
          closeProviderModal();
          resetProviderForm();
          setStatus(wasEditing ? t("status.providerUpdated") : t("status.providerSaved"));
          await loadState();
        } catch (err) {
          setStatus(err.message, true);
        }
      });

      // Render one chat message bubble.
      function renderMessage(message) {
        hideChatEmptyState();
        const item = document.createElement("div");
        item.className = "message " + message.role;
        item.textContent = message.content || " ";
        messagesEl.appendChild(item);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return item;
      }

      // Extract text deltas from Claude-style SSE chunks.
      function extractTextDelta(rawData) {
        if (!rawData || rawData === "[DONE]") return "";
        try {
          const payload = JSON.parse(rawData);
          if (payload.delta && typeof payload.delta.text === "string") return payload.delta.text;
          if (payload.content_block && typeof payload.content_block.text === "string") {
            return payload.content_block.text;
          }
          if (typeof payload.text === "string") return payload.text;
          return "";
        } catch {
          return rawData;
        }
      }

      // Extract Claude-style usage deltas from streamed message_delta events.
      function extractUsageDelta(rawData) {
        if (!rawData || rawData === "[DONE]") return null;
        try {
          const payload = JSON.parse(rawData);
          const usage = payload.usage;
          if (!usage || typeof usage !== "object") return null;
          if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") {
            return null;
          }
          return usage;
        } catch {
          return null;
        }
      }

      // Append streamed SSE text to the current assistant bubble.
      async function readChatStream(response, assistantMessage, assistantEl) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let latestUsage = null;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const eventText of events) {
            const lines = eventText.split("\n").filter((line) => line.startsWith("data:"));
            for (const line of lines) {
              const rawData = line.slice(5).trim();
              const usage = extractUsageDelta(rawData);
              if (usage) {
                latestUsage = usage;
                renderChatUsage(usage);
              }

              const delta = extractTextDelta(rawData);
              if (delta) {
                assistantMessage.content += delta;
                assistantEl.textContent = assistantMessage.content;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
            }
          }
        }
        return latestUsage;
      }

      // Send the current conversation through the real /api/chat endpoint.
      async function sendChatMessage() {
        const text = chatInputEl.value.trim();
        if (!text) return;

        const userMessage = { role: "user", content: text };
        const assistantMessage = { role: "assistant", content: "" };
        chatMessages.push(userMessage);
        renderMessage(userMessage);
        const assistantEl = renderMessage(assistantMessage);
        chatInputEl.value = "";
        chatAbortController = new AbortController();
        chatSendEl.disabled = true;
        chatStopEl.disabled = false;
        chatUsageState = "waiting";
        lastChatUsage = null;
        renderChatUsageState();
        setStatus(t("status.sending"));

        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              provider: chatProviderEl.value,
              model: chatModelEl.value,
              messages: chatMessages,
            }),
            signal: chatAbortController.signal,
          });
          if (!response.ok) {
            throw new Error(await response.text());
          }
          if (!response.body) {
            throw new Error(t("error.chatStreamUnavailable"));
          }
          const usage = await readChatStream(response, assistantMessage, assistantEl);
          if (!usage) renderChatUsage(null);
          chatMessages.push(assistantMessage);
          setStatus(t("status.chatComplete"));
        } catch (err) {
          assistantMessage.content = err.name === "AbortError" ? t("status.stopped") : err.message;
          assistantEl.textContent = assistantMessage.content;
          setStatus(assistantMessage.content, err.name !== "AbortError");
        } finally {
          chatAbortController = null;
          chatSendEl.disabled = false;
          chatStopEl.disabled = true;
        }
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

      // Wire chat controls.
      document.querySelector("#chat-clear").addEventListener("click", () => {
        chatMessages = [];
        showChatEmptyState();
        chatUsageState = "none";
        lastChatUsage = null;
        renderChatUsageState();
        setStatus(t("status.chatCleared"));
      });
      chatStopEl.addEventListener("click", () => {
        if (chatAbortController) chatAbortController.abort();
      });
      document.querySelector("#chat-form").addEventListener("submit", (event) => {
        event.preventDefault();
        sendChatMessage();
      });

      // Initialize theme before fetching state to avoid a bright flash.
      initializeComboboxes();
      updateComboOptions("formats", ["openai", "anthropic", "gemini"]);
      applyTheme(localStorage.getItem("claudish-theme") || "dark");
      applyLanguage(detectInitialLanguage());
      loadState().catch((err) => setStatus(err.message, true));
    </script>
  </body>
</html>`;
}
