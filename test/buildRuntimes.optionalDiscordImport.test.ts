import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("build runtimes optional discord import", () => {
  test("builds Feishu-only runtimes without discord.js installed", async () => {
    const fixtureRoot = path.join(os.tmpdir(), `build-runtimes-no-discord-${randomUUID()}`);
    tempDirs.push(fixtureRoot);

    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.cp(path.resolve(process.cwd(), "src"), path.join(fixtureRoot, "src"), {
      recursive: true,
      force: true
    });
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{\n  "type": "module"\n}\n', "utf8");
    await mirrorNodeModulesWithoutDiscordJs(fixtureRoot);

    const fixtureModulePath = path.join(fixtureRoot, "src", "app", "buildRuntimes.js");
    const { buildBridgeRuntimes } = await import(pathToFileURL(fixtureModulePath).href);
    const result = await buildBridgeRuntimes({
      runtimeContext: {
        path,
        fs,
        execFileAsync: async () => ({ stdout: "", stderr: "" }),
        discord: {
          channels: {
            fetch: async () => null
          }
        },
        discordToken: "",
        fetchChannelByRouteId: async () => null,
        processStartedAt: new Date().toISOString(),
        codex: {},
        agentClientRegistry: {
          getClient: () => ({}),
          hasClient: () => false
        },
        config: {
          bots: {
            "feishu-support": {
              platform: "feishu",
              runtime: "claude",
              auth: {
                appId: "app-id",
                appSecret: "app-secret"
              },
              routes: {}
            }
          }
        },
        state: {
          findConversationChannelIdByAgentThreadId: () => null,
          getBinding: () => null,
          setBinding: () => {},
          save: async () => {}
        },
        activeTurns: new Map(),
        pendingApprovals: new Map()
      },
      runtimeEnv: {
        backendHttpEnabled: false,
        backendHttpHost: "127.0.0.1",
        backendHttpPort: 8788,
        feishuEnabled: true,
        feishuAppId: "app-id",
        feishuAppSecret: "app-secret",
        feishuTransport: "long-connection",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: path.join(fixtureRoot, ".cache"),
        feishuEventDedupePath: path.join(fixtureRoot, "data", "feishu-seen-events.json"),
        feishuEventDedupeTtlMs: 60_000
      },
      runtimeServices: {
        runtimeAdapters: {
          maybeSendAttachmentsForItem: async () => {},
          maybeSendInferredAttachmentsFromText: async () => {},
          writeHeartbeatFile: async () => {},
          shouldHandleAsSelfRestartRequest: () => false,
          requestSelfRestartFromDiscord: async () => {},
          collectImageAttachments: () => [],
          buildTurnInputFromMessage: async () => [],
          enqueuePrompt: () => {},
          getQueue: () => ({ jobs: [] }),
          findActiveTurnByRepoChannel: () => null,
          findLatestPendingApprovalTokenForChannel: () => null,
          applyApprovalDecision: async () => ({ ok: true })
        },
        safeReply: async () => {},
        safeSendToChannel: async () => {},
        safeAddReaction: async () => {},
        debugLog: () => {},
        turnRecoveryStore: {
          removeTurn: async () => {}
        },
        createApprovalToken: () => "0001",
        sendChunkedToChannel: async () => {}
      },
      channelSetupStore: {
        getChannelSetups: () => ({}),
        setChannelSetups: () => {}
      },
      ioRuntime: {
        waitForDiscordReady: async () => {},
        isDiscordMissingPermissionsError: () => false
      }
    });

    expect(result.platformRegistry.listEnabledPlatforms().map((platform) => platform.platformId)).toEqual(["feishu"]);
    expect(result.feishuRuntime.enabled).toBe(true);
  });
});

async function mirrorNodeModulesWithoutDiscordJs(fixtureRoot: string) {
  const sourceNodeModulesPath = path.resolve(process.cwd(), "node_modules");
  const fixtureNodeModulesPath = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(fixtureNodeModulesPath, { recursive: true });

  for (const entry of await fs.readdir(sourceNodeModulesPath)) {
    if (entry === "discord.js") {
      continue;
    }
    await fs.symlink(path.join(sourceNodeModulesPath, entry), path.join(fixtureNodeModulesPath, entry));
  }
}
