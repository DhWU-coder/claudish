import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createFeishuMediaClient, createSdkFeishuReactionClient } from "./client.js";

describe("Feishu SDK client adapters", () => {
  test("createFeishuMediaClient downloads image resources", async () => {
    const calls: unknown[] = [];
    const mediaClient = createFeishuMediaClient({
      im: {
        v1: {
          messageResource: {
            async get(payload: unknown) {
              calls.push(payload);
              return {
                headers: { "content-type": "image/png" },
                getReadableStream() {
                  return Readable.from([Buffer.from("png-data")]);
                },
              };
            },
          },
        },
      },
    });

    const result = await mediaClient.downloadImage("img_1", "om_1");

    expect(calls).toEqual([
      {
        params: { type: "image" },
        path: { message_id: "om_1", file_key: "img_1" },
      },
    ]);
    expect(result.contentType).toBe("image/png");
    expect(result.buffer.toString("utf-8")).toBe("png-data");
  });

  test("createSdkFeishuReactionClient adds and removes typing reactions", async () => {
    const calls: unknown[] = [];
    const reactionClient = createSdkFeishuReactionClient({
      im: {
        v1: {
          messageReaction: {
            async create(payload: unknown) {
              calls.push(["create", payload]);
              return { data: { reaction_id: "reaction_1" } };
            },
            async delete(payload: unknown) {
              calls.push(["delete", payload]);
              return {};
            },
          },
        },
      },
    });

    const result = await reactionClient.addTypingReaction({ messageId: "om_1" });
    await reactionClient.removeTypingReaction({
      messageId: "om_1",
      reactionId: result.reactionId!,
    });

    expect(calls).toEqual([
      [
        "create",
        {
          path: { message_id: "om_1" },
          data: { reaction_type: { emoji_type: "Typing" } },
        },
      ],
      [
        "delete",
        {
          path: { message_id: "om_1", reaction_id: "reaction_1" },
        },
      ],
    ]);
  });
});
