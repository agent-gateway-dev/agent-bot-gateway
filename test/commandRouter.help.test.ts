import { describe, expect, test } from "bun:test";
import { createCommandRouter } from "../src/commands/router.js";

function createRouterWithRegistry(registry: unknown) {
  return createCommandRouter({
    ChannelType: { GuildText: 0 },
    isGeneralChannel: () => false,
    fs: { mkdir: async () => {}, stat: async () => {} },
    path: { join: (...parts: string[]) => parts.join("/"), dirname: () => "/tmp" },
    execFileAsync: async () => {},
    repoRootPath: "/tmp/repos",
    managedChannelTopicPrefix: "codex-cwd:",
    codexBin: "codex",
    codexHomeEnv: null,
    statePath: "/tmp/state.json",
    configPath: "/tmp/channels.json",
    config: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      defaultModel: "gpt-5.3-codex"
    },
    state: {
      getBinding: () => null,
      clearBinding: () => {},
      save: async () => {}
    },
    codex: {
      request: async () => {}
    },
    pendingApprovals: new Map(),
    makeChannelName: (name: string) => name,
    collectImageAttachments: () => [],
    buildTurnInputFromMessage: async () => [],
    enqueuePrompt: () => {},
    getQueue: () => ({ jobs: [] }),
    findActiveTurnByRepoChannel: () => null,
    requestSelfRestartFromDiscord: async () => {},
    findLatestPendingApprovalTokenForChannel: () => null,
    applyApprovalDecision: async () => ({ ok: true }),
    safeReply: async () => null,
    getChannelSetups: () => ({}),
    setChannelSetups: () => {},
    getPlatformRegistry: () => registry
  });
}

describe("command router help text", () => {
  test("shows Discord interactive capabilities when supported", () => {
    const router = createRouterWithRegistry({
      getCapabilities: () => ({
        supportsSlashCommands: true,
        supportsButtons: true,
        supportsRepoBootstrap: true
      }),
      anyPlatformSupports: () => true,
      platformSupports: () => true
    });

    const helpText = router.getHelpText({ platformId: "discord" });
    expect(helpText).toContain("use `!command` or `/command`");
    expect(helpText).toContain("`!initrepo [force]`");
    expect(helpText).toContain("Approve/Decline/Cancel buttons");
    expect(helpText).toContain("`!resync`");
  });

  test("omits unsupported Discord-only commands in Feishu help text", () => {
    const router = createRouterWithRegistry({
      getCapabilities: () => ({
        supportsSlashCommands: false,
        supportsButtons: false,
        supportsRepoBootstrap: false
      }),
      anyPlatformSupports: () => false,
      platformSupports: () => false
    });

    const helpText = router.getHelpText({ platformId: "feishu" });
    expect(helpText).toContain("use `/command`");
    expect(helpText).not.toContain("`/initrepo [force]`");
    expect(helpText).not.toContain("buttons on approval messages");
    expect(helpText).toContain("Feishu repo chat bindings are config-driven");
  });
});
