export interface FeishuMessageClient {
  replyText(input: { messageId: string; text: string }): Promise<void>;
  sendText(input: { receiveId: string; receiveIdType: string; text: string }): Promise<void>;
}

export interface FeishuTextTarget {
  replyToMessageId?: string;
  receiveId?: string;
  receiveIdType?: string;
  text: string;
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

export function createSdkFeishuMessageClient(client: any): FeishuMessageClient {
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
  };
}

function textMessageData(text: string) {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}
