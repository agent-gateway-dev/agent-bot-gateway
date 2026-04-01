import { describe, expect, test } from "bun:test";
import { summarizePlatformReadiness } from "../src/app/startup.js";
import { createPlatformRegistry } from "../src/platforms/platformRegistry.js";

describe("platform registry multi-bot", () => {
  test("resolves scoped route ids through the matching bot instance", async () => {
    const registry = createPlatformRegistry([
      {
        platformId: "discord",
        botId: "discord-main",
        instanceKey: "discord-main",
        enabled: true,
        canHandleRouteId: (routeId: string) => routeId === "123",
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, botId: "discord-main" })
      },
      {
        platformId: "discord",
        botId: "discord-review",
        instanceKey: "discord-review",
        enabled: true,
        canHandleRouteId: (routeId: string) => routeId === "123",
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, botId: "discord-review" })
      },
      {
        platformId: "feishu",
        botId: "feishu-support",
        instanceKey: "feishu-support",
        enabled: true,
        canHandleRouteId: (routeId: string) => routeId === "oc_1",
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, botId: "feishu-support" })
      }
    ]);

    expect(await registry.fetchChannelByRouteId("bot:discord-review:route:123")).toEqual({
      id: "123",
      botId: "discord-review"
    });
    expect(await registry.fetchChannelByRouteId("bot:feishu-support:route:oc_1")).toEqual({
      id: "oc_1",
      botId: "feishu-support"
    });
  });

  test("reports readiness per bot instance instead of collapsing by platform id", () => {
    const readiness = summarizePlatformReadiness(
      {
        listEnabledPlatforms: () => [
          { platformId: "discord", botId: "discord-main", instanceKey: "discord-main" },
          { platformId: "discord", botId: "discord-review", instanceKey: "discord-review" }
        ]
      },
      [
        { platformId: "discord", botId: "discord-main", instanceKey: "discord-main", started: true },
        {
          platformId: "discord",
          botId: "discord-review",
          instanceKey: "discord-review",
          started: false,
          startError: new Error("discord review startup failed")
        }
      ]
    );

    expect(readiness).toEqual({
      ready: false,
      degradedPlatforms: [
        {
          platformId: "discord",
          botId: "discord-review",
          reason: "startup_failed",
          message: "discord review startup failed"
        }
      ]
    });
  });
});
