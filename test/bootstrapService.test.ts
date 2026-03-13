import { describe, expect, test } from "bun:test";
import { createBootstrapService } from "../src/channels/bootstrapService.js";

describe("bootstrap service", () => {
  test("preserves external route setups and bindings during Discord sync", async () => {
    let channelSetups = {
      "feishu:oc_1": { cwd: "/tmp/feishu-repo", model: "gpt-5.3-codex" },
      "123": { cwd: "/tmp/stale-discord-repo", model: "gpt-5.3-codex" }
    };
    const clearedBindings: string[] = [];
    let saveCalls = 0;

    const guild = {
      channels: {
        cache: new Map(),
        async fetch() {},
        async create(payload: { name: string; type: string }) {
          const category = {
            id: "cat-1",
            name: payload.name,
            type: payload.type
          };
          this.cache.set(category.id, category);
          return category;
        }
      }
    };

    const bootstrapService = createBootstrapService({
      ChannelType: {
        GuildText: "GuildText",
        GuildCategory: "GuildCategory"
      },
      path: await import("node:path"),
      discord: {
        guilds: {
          cache: new Map([["guild-1", guild]])
        }
      },
      codex: {
        async request() {
          return { data: [] };
        }
      },
      config: {
        autoDiscoverProjects: false,
        channels: {},
        defaultModel: "gpt-5.3-codex"
      },
      state: {
        snapshot() {
          return {
            threadBindings: {
              "feishu:oc_1": {
                repoChannelId: "feishu:oc_1",
                codexThreadId: "thread-feishu",
                cwd: "/tmp/feishu-repo"
              },
              "123": {
                repoChannelId: "123",
                codexThreadId: "thread-discord",
                cwd: "/tmp/stale-discord-repo"
              }
            }
          };
        },
        clearBinding(repoChannelId: string) {
          clearedBindings.push(repoChannelId);
        },
        async save() {
          saveCalls += 1;
        }
      },
      projectsCategoryName: "codex-projects",
      managedChannelTopicPrefix: "codex-cwd:",
      managedThreadTopicPrefix: "codex-thread:",
      isDiscordMissingPermissionsError: () => false,
      getChannelSetups: () => channelSetups,
      setChannelSetups: (nextSetups: typeof channelSetups) => {
        channelSetups = nextSetups;
      }
    });

    const summary = await bootstrapService.bootstrapChannelMappings();

    expect(summary.prunedBindings).toBe(1);
    expect(channelSetups).toEqual({
      "feishu:oc_1": { cwd: "/tmp/feishu-repo", model: "gpt-5.3-codex" }
    });
    expect(clearedBindings).toEqual(["123"]);
    expect(saveCalls).toBe(1);
  });
});
