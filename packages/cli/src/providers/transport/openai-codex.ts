/**
 * OpenAI Codex ProviderTransport
 *
 * Extends OpenAI transport with OAuth token support for ChatGPT Plus/Pro subscriptions.
 *
 * On each request, checks for OAuth credentials (~/.claudish/codex-oauth.json).
 * If found, uses the OAuth access_token + ChatGPT-Account-ID header.
 * Falls back to API key (OPENAI_CODEX_API_KEY) if no OAuth credentials.
 *
 * IMPORTANT: When using OAuth tokens, requests go to chatgpt.com/backend-api, NOT api.openai.com
 * The OAuth token only works with ChatGPT's internal API.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCodexModel } from "../../adapters/codex-api-format.js";
import { CodexOAuth } from "../../auth/codex-oauth.js";
import { log } from "../../logger.js";
import { OpenAIProviderTransport } from "./openai.js";

const OPENCLAW_ATTRIBUTION_ORIGINATOR = "openclaw";
const OPENCLAW_ATTRIBUTION_VERSION =
  process.env.OPENCLAW_VERSION || process.env.OPENCLAW_SERVICE_VERSION || "unknown";

function getCodexCredentialsPath(): string {
  const claudishDir = process.env.CLAUDISH_HOME || join(homedir(), ".claudish");
  return join(claudishDir, "codex-oauth.json");
}

function buildOAuthHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: OPENCLAW_ATTRIBUTION_ORIGINATOR,
    version: OPENCLAW_ATTRIBUTION_VERSION,
    "User-Agent": `${OPENCLAW_ATTRIBUTION_ORIGINATOR}/${OPENCLAW_ATTRIBUTION_VERSION}`,
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }
  return headers;
}

/** Base URL for ChatGPT Codex backend API (used with OAuth tokens) */
const CHATGPT_API_URL = "https://chatgpt.com/backend-api/codex";

export class OpenAICodexTransport extends OpenAIProviderTransport {
  override async getHeaders(): Promise<Record<string, string>> {
    const oauthHeaders = await this.tryOAuthHeaders();
    if (oauthHeaders) return oauthHeaders;
    // Fall back to API key auth
    return super.getHeaders();
  }

  /**
   * Override endpoint to use ChatGPT API when OAuth credentials exist.
   * OAuth tokens only work with chatgpt.com/backend-api, not api.openai.com.
   * API keys use the standard OpenAI API endpoint.
   */
  getEndpoint(): string {
    // Check if OAuth credentials exist (synchronous check)
    const credPath = getCodexCredentialsPath();
    if (existsSync(credPath)) {
      try {
        const creds = JSON.parse(readFileSync(credPath, "utf-8"));
        if (hasOAuthCredentialPair(creds)) {
          // OAuth tokens work with chatgpt.com/backend-api
          return `${CHATGPT_API_URL}/responses`;
        }
      } catch {
        // Fall through to API key
      }
    }
    // API keys use the standard OpenAI API endpoint
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  /**
   * Attempt to load OAuth credentials and return headers.
   * Returns null if no valid OAuth credentials are available.
   */
  private async tryOAuthHeaders(): Promise<Record<string, string> | null> {
    const credPath = getCodexCredentialsPath();
    if (!existsSync(credPath)) return null;

    try {
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      const flatCreds = flattenCodexCredentials(creds);
      if (!flatCreds) return null;

      // Check if token needs refresh
      const buffer = 5 * 60 * 1000;
      if (flatCreds.expires_at && Date.now() > flatCreds.expires_at - buffer) {
        const oauth = CodexOAuth.getInstance();
        const token = await oauth.getAccessToken();
        log("[OpenAI Codex] Using refreshed OAuth token");
        return buildOAuthHeaders(token, oauth.getAccountId());
      }

      // Token still valid
      log("[OpenAI Codex] Using OAuth token (subscription)");
      return buildOAuthHeaders(flatCreds.access_token, flatCreds.account_id);
    } catch (e) {
      log(`[OpenAI Codex] OAuth credential read failed: ${e}, falling back to API key`);
      return null;
    }
  }

  /**
   * Transform the request payload to normalize the model name for ChatGPT backend.
   * The ChatGPT backend doesn't recognize OpenAI model names like "gpt-4.5" -
   * it only knows ChatGPT-specific model names like "gpt-5.1", "gpt-5.2-codex", etc.
   */
  transformPayload(payload: any): any {
    log(`[OpenAI Codex] transformPayload called - payload.model: "${payload?.model}"`);
    let transformedPayload = payload;
    if (payload?.model) {
      const normalized = normalizeCodexModel(payload.model);
      if (normalized !== payload.model) {
        log(`[OpenAI Codex] Normalized model: ${payload.model} → ${normalized}`);
        transformedPayload = { ...payload, model: normalized };
      }
    }
    // Add Codex-specific fields that the opencode reference implementation uses
    // store: false = stateless operation (required by ChatGPT backend for Codex)
    // include: reasoning.encrypted_content = for reasoning continuity across turns
    return {
      ...transformedPayload,
      store: false,
      include: ["reasoning.encrypted_content"],
    };
  }
}

function hasOAuthCredentialPair(creds: any): boolean {
  return !!flattenCodexCredentials(creds);
}

function flattenCodexCredentials(creds: any): {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  account_id?: string;
} | null {
  if (typeof creds?.access_token === "string" && typeof creds?.refresh_token === "string") {
    return {
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expires_at: typeof creds.expires_at === "number" ? creds.expires_at : undefined,
      account_id: typeof creds.account_id === "string" ? creds.account_id : undefined,
    };
  }
  if (
    creds?.auth_mode === "chatgpt" &&
    typeof creds.tokens?.access_token === "string" &&
    typeof creds.tokens?.refresh_token === "string"
  ) {
    return {
      access_token: creds.tokens.access_token,
      refresh_token: creds.tokens.refresh_token,
      expires_at: typeof creds.expires === "number" ? creds.expires : undefined,
      account_id: typeof creds.tokens.account_id === "string" ? creds.tokens.account_id : undefined,
    };
  }
  return null;
}
