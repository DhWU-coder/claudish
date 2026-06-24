import type { Readable } from "node:stream";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuEventClient, FeishuMediaClient, FeishuReactionClient } from "./channel.js";
import type { FeishuConfig } from "./config.js";
import { type FeishuMessageClient, createSdkFeishuMessageClient } from "./send.js";

export interface FeishuSdkClients {
  eventClient: FeishuEventClient;
  mediaClient: FeishuMediaClient;
  messageClient: FeishuMessageClient;
  reactionClient: FeishuReactionClient;
}

interface FeishuSdkMessageReactionApi {
  create(input: unknown): Promise<{ data?: { reaction_id?: string } }>;
  delete(input: unknown): Promise<unknown>;
}

interface FeishuSdkReactionClientLike {
  im?: {
    v1?: {
      messageReaction?: FeishuSdkMessageReactionApi;
    };
    messageReaction?: FeishuSdkMessageReactionApi;
  };
}

interface FeishuWsClientLike {
  start(input: unknown): Promise<void> | void;
  close(input: unknown): void;
}

interface FeishuSdkMediaClientLike {
  im: {
    v1: {
      messageResource: {
        get(input: unknown): Promise<{
          headers?: Record<string, string>;
          getReadableStream(): Readable;
        }>;
      };
    };
  };
}

export function createFeishuSdkClients(config: FeishuConfig): FeishuSdkClients {
  const sdkConfig = {
    appId: config.appId!,
    appSecret: config.appSecret!,
    domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
  };
  const client = new Lark.Client(sdkConfig);
  const wsClient = new Lark.WSClient({
    ...sdkConfig,
    loggerLevel: Lark.LoggerLevel.info,
    source: "claudish",
  });

  return {
    eventClient: createFeishuEventClient(wsClient),
    mediaClient: createFeishuMediaClient(client),
    messageClient: createSdkFeishuMessageClient(client),
    reactionClient: createSdkFeishuReactionClient(client),
  };
}

export function createFeishuEventClient(wsClient: FeishuWsClientLike): FeishuEventClient {
  return {
    async start(onEvent) {
      const eventDispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => onEvent({ event: data }),
      });
      await wsClient.start({ eventDispatcher });
    },
    async stop() {
      wsClient.close({ force: true });
    },
  };
}

export function createFeishuMediaClient(client: FeishuSdkMediaClientLike): FeishuMediaClient {
  return {
    async downloadImage(imageKey, messageId) {
      const response = await client.im.v1.messageResource.get({
        params: { type: "image" },
        path: { message_id: messageId, file_key: imageKey },
      });
      return {
        buffer: await readableToBuffer(response.getReadableStream()),
        contentType: response.headers?.["content-type"] ?? "image/png",
      };
    },
    async downloadFile(fileKey, messageId) {
      const response = await client.im.v1.messageResource.get({
        params: { type: "file" },
        path: { message_id: messageId, file_key: fileKey },
      });
      return {
        buffer: await readableToBuffer(response.getReadableStream()),
        contentType: response.headers?.["content-type"] ?? "application/octet-stream",
      };
    },
  };
}

export function createSdkFeishuReactionClient(
  client: FeishuSdkReactionClientLike
): FeishuReactionClient {
  return {
    async addTypingReaction(input) {
      const response = await resolveMessageReactionApi(client).create({
        path: { message_id: input.messageId },
        data: {
          reaction_type: {
            emoji_type: "Typing",
          },
        },
      });
      return {
        reactionId: response?.data?.reaction_id ?? null,
      };
    },
    async removeTypingReaction(input) {
      await resolveMessageReactionApi(client).delete({
        path: {
          message_id: input.messageId,
          reaction_id: input.reactionId,
        },
      });
    },
  };
}

function resolveMessageReactionApi(
  client: FeishuSdkReactionClientLike
): FeishuSdkMessageReactionApi {
  const api = client.im?.v1?.messageReaction ?? client.im?.messageReaction;
  if (!api) {
    throw new Error("Feishu message reaction API is unavailable");
  }
  return api;
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
