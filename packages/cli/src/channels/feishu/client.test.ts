import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import { createFeishuMediaClient } from "./client.js";

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
});
