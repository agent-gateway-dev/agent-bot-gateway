import { describe, expect, test } from "bun:test";
import { createFeishuPlatform } from "../src/platforms/feishuPlatform.js";

describe("feishu platform", () => {
  test("exposes webhook ingress only when webhook transport is enabled", () => {
    const webhookPlatform = createFeishuPlatform({
      runtime: {
        enabled: true,
        transport: "webhook",
        webhookPath: "/feishu/events"
      }
    });
    const longConnectionPlatform = createFeishuPlatform({
      runtime: {
        enabled: true,
        transport: "long-connection",
        webhookPath: ""
      }
    });

    expect(webhookPlatform.capabilities.supportsWebhookIngress).toBe(true);
    expect(webhookPlatform.getHttpEndpoints()).toEqual(["/feishu/events"]);
    expect(webhookPlatform.matchesHttpRequest({ pathname: "/feishu/events" })).toBe(true);

    expect(longConnectionPlatform.capabilities.supportsWebhookIngress).toBe(false);
    expect(longConnectionPlatform.getHttpEndpoints()).toEqual([]);
    expect(longConnectionPlatform.matchesHttpRequest({ pathname: "/feishu/events" })).toBe(false);
  });
});
