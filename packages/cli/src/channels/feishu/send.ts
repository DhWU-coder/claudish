import { createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import type { ChannelConnectionCheck, ChannelConnectionTestResult } from "../types.js";

export type FeishuConnectionCheck = ChannelConnectionCheck;
export type FeishuConnectionTestResult = ChannelConnectionTestResult;

export interface FeishuConnectionTestInput {
  expectedBotOpenId?: string;
}

export interface FeishuMessageClient {
  replyText(input: { messageId: string; text: string }): Promise<void>;
  sendText(input: { receiveId: string; receiveIdType: string; text: string }): Promise<void>;
  testConnection?(input: FeishuConnectionTestInput): Promise<FeishuConnectionTestResult>;
  replyFile?(input: { messageId: string; filePath: string; fileName?: string }): Promise<void>;
  sendFile?(input: {
    receiveId: string;
    receiveIdType: string;
    filePath: string;
    fileName?: string;
  }): Promise<void>;
}

export interface FeishuTextTarget {
  replyToMessageId?: string;
  receiveId?: string;
  receiveIdType?: string;
  text: string;
}

export interface FeishuFileTarget {
  replyToMessageId?: string;
  receiveId?: string;
  receiveIdType?: string;
  filePath: string;
  fileName?: string;
}

interface FeishuSdkMessageClientLike {
  auth?: {
    v3?: {
      tenantAccessToken?: {
        internal(
          input: unknown
        ): Promise<{ code?: number; msg?: string; tenant_access_token?: string }>;
      };
    };
  };
  im: {
    v1: {
      file?: {
        create(input: unknown): Promise<{ file_key?: string } | null>;
      };
      message: {
        reply(input: unknown): Promise<unknown>;
        create(input: unknown): Promise<unknown>;
      };
    };
  };
}

export function splitFeishuText(text: string, maxLength = 3500): string[] {
  const normalized = text || " ";
  const chunks: string[] = [];

  for (let index = 0; index < normalized.length; index += maxLength) {
    chunks.push(normalized.slice(index, index + maxLength));
  }

  return chunks;
}

export async function sendFeishuText(
  client: FeishuMessageClient,
  target: FeishuTextTarget,
  maxLength = 3500
): Promise<void> {
  for (const chunk of splitFeishuText(target.text, maxLength)) {
    if (target.replyToMessageId) {
      await client.replyText({ messageId: target.replyToMessageId, text: chunk });
    } else if (target.receiveId && target.receiveIdType) {
      await client.sendText({
        receiveId: target.receiveId,
        receiveIdType: target.receiveIdType,
        text: chunk,
      });
    }
  }
}

export async function sendFeishuFile(
  client: FeishuMessageClient,
  target: FeishuFileTarget
): Promise<void> {
  if (target.replyToMessageId) {
    if (!client.replyFile) throw new Error("Feishu file reply is unavailable");
    await client.replyFile({
      messageId: target.replyToMessageId,
      filePath: target.filePath,
      fileName: target.fileName,
    });
  } else if (target.receiveId && target.receiveIdType) {
    if (!client.sendFile) throw new Error("Feishu file send is unavailable");
    await client.sendFile({
      receiveId: target.receiveId,
      receiveIdType: target.receiveIdType,
      filePath: target.filePath,
      fileName: target.fileName,
    });
  }
}

export function createSdkFeishuMessageClient(
  client: FeishuSdkMessageClientLike,
  config?: { appId?: string; appSecret?: string }
): FeishuMessageClient {
  const uploadFile = async (filePath: string, fileName?: string): Promise<string> => {
    if (!client.im.v1.file?.create) throw new Error("Feishu file upload API is unavailable");
    const response = await client.im.v1.file.create({
      data: {
        file_type: fileTypeFromPath(filePath),
        file_name: fileName || basename(filePath),
        file: createReadStream(filePath),
      },
    });
    const fileKey = response?.file_key;
    if (!fileKey) throw new Error("Feishu file upload did not return file_key");
    return fileKey;
  };

  return {
    async replyText(input) {
      await client.im.v1.message.reply({
        path: { message_id: input.messageId },
        data: textMessageData(input.text),
      });
    },
    async sendText(input) {
      await client.im.v1.message.create({
        params: { receive_id_type: input.receiveIdType },
        data: {
          receive_id: input.receiveId,
          ...textMessageData(input.text),
        },
      });
    },
    async testConnection(input) {
      return testSdkFeishuConnection(client, input, config);
    },
    async replyFile(input) {
      const fileKey = await uploadFile(input.filePath, input.fileName);
      await client.im.v1.message.reply({
        path: { message_id: input.messageId },
        data: fileMessageData(fileKey),
      });
    },
    async sendFile(input) {
      const fileKey = await uploadFile(input.filePath, input.fileName);
      await client.im.v1.message.create({
        params: { receive_id_type: input.receiveIdType },
        data: {
          receive_id: input.receiveId,
          ...fileMessageData(fileKey),
        },
      });
    },
  };
}

async function testSdkFeishuConnection(
  client: FeishuSdkMessageClientLike,
  input: FeishuConnectionTestInput,
  config?: { appId?: string; appSecret?: string }
): Promise<FeishuConnectionTestResult> {
  const startedAt = Date.now();
  const checks: FeishuConnectionCheck[] = [];
  const tokenApi = client.auth?.v3?.tenantAccessToken?.internal;

  if (!tokenApi) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checks: [{ name: "tenant_access_token", ok: false, message: "API unavailable" }],
      error: "Feishu tenant access token API is unavailable.",
    };
  }

  try {
    const response = await tokenApi({
      data: {
        app_id: config?.appId,
        app_secret: config?.appSecret,
      },
    });
    const code = Number(response?.code ?? 0);
    if (code !== 0) {
      const message = response?.msg || `Feishu returned code ${code}`;
      checks.push({ name: "tenant_access_token", ok: false, message });
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        checks,
        error: message,
      };
    }

    checks.push({ name: "tenant_access_token", ok: true, message: "ok" });
    if (input.expectedBotOpenId) {
      checks.push({
        name: "bot_open_id",
        ok: true,
        message: "configured",
      });
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      checks,
    };
  } catch (error) {
    const message = formatError(error);
    checks.push({ name: "tenant_access_token", ok: false, message });
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      checks,
      error: message,
    };
  }
}

function textMessageData(text: string) {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}

function fileMessageData(fileKey: string) {
  return {
    msg_type: "file",
    content: JSON.stringify({ file_key: fileKey }),
  };
}

function fileTypeFromPath(
  filePath: string
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".opus") return "opus";
  if (ext === ".mp4") return "mp4";
  if (ext === ".pdf") return "pdf";
  if ([".doc", ".docx"].includes(ext)) return "doc";
  if ([".xls", ".xlsx"].includes(ext)) return "xls";
  if ([".ppt", ".pptx"].includes(ext)) return "ppt";
  return "stream";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
