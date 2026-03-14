import { describe, expect, test } from "bun:test";
import { createChannelMessaging } from "../src/app/channelMessaging.js";

describe("channel messaging ANSI sanitization", () => {
  test("strips ANSI when sending to Feishu channel", async () => {
    const sends: string[] = [];
    const channel = {
      id: "feishu:oc_1",
      platform: "feishu",
      isTextBased: () => true,
      async send(content: string) {
        sends.push(content);
        return null;
      }
    };
    const messaging = createChannelMessaging({
      fetchChannelByRouteId: async () => null
    });

    await messaging.safeSendToChannel(channel, "\u001b[32m+12\u001b[0m");

    expect(sends).toEqual(["+12"]);
  });

  test("keeps ANSI for Discord by default", async () => {
    const sends: string[] = [];
    const channel = {
      id: "123",
      platform: "discord",
      isTextBased: () => true,
      async send(content: string) {
        sends.push(content);
        return null;
      }
    };
    const messaging = createChannelMessaging({
      fetchChannelByRouteId: async () => null
    });

    await messaging.safeSendToChannel(channel, "\u001b[32m+12\u001b[0m");

    expect(sends).toEqual(["\u001b[32m+12\u001b[0m"]);
  });

  test("strips ANSI for Discord when toggle enabled", async () => {
    const sends: string[] = [];
    const channel = {
      id: "123",
      platform: "discord",
      isTextBased: () => true,
      async send(content: string) {
        sends.push(content);
        return null;
      }
    };
    const messaging = createChannelMessaging({
      fetchChannelByRouteId: async () => null,
      stripAnsiForDiscord: true
    });

    await messaging.safeSendToChannel(channel, "\u001b[31m-3\u001b[0m");

    expect(sends).toEqual(["-3"]);
  });

  test("sanitizes payload.content for Feishu", async () => {
    const sends: Array<{ content?: string }> = [];
    const channel = {
      id: "feishu:oc_1",
      platform: "feishu",
      isTextBased: () => true,
      async send(payload: { content?: string }) {
        sends.push(payload);
        return null;
      }
    };
    const messaging = createChannelMessaging({
      fetchChannelByRouteId: async () => null
    });

    await messaging.safeSendToChannelPayload(channel, {
      content: "```ansi\n\u001b[32m+12\u001b[0m\n```"
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.content).toContain("+12");
    expect(sends[0]?.content).not.toContain("\u001b");
  });
});
