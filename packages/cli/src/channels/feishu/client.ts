import * as Lark from "@larksuiteoapi/node-sdk";
import type { Readable } from "node:stream";
import type { FeishuEventClient, FeishuMediaClient } from "./channel.js";
import type { FeishuConfig } from "./config.js";
import { createSdkFeishuMessageClient, type FeishuMessageClient } from "./send.js";

export interface FeishuSdkClients {
  eventClient: FeishuEventClient;
  mediaClient: FeishuMediaClient;
  messageClient: FeishuMessageClient;
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
  };
}

export function createFeishuEventClient(wsClient: any): FeishuEventClient {
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

export function createFeishuMediaClient(client: any): FeishuMediaClient {
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
  };
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
