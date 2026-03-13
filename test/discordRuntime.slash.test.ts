import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { createDiscordRuntime } from "../src/app/discordRuntime.js";

function createInteraction(commandName: string, options: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const channel = {
    id: "channel-1",
    name: "repo-one",
    type: ChannelType.GuildText
  };
  const statusMessage = {
    id: "msg-1",
    channel,
    channelId: channel.id,
    async edit(content: string) {
      replies.push(content);
      return this;
    }
  };

  return {
    replies,
    interaction: {
      id: `ix-${commandName}`,
      user: { id: "user-1" },
      channel,
      channelId: channel.id,
      commandName,
      customId: "",
      deferred: false,
      replied: false,
      options: {
        getString(name: string) {
          const value = options[name];
          return typeof value === "string" ? value : null;
        },
        getBoolean(name: string) {
          const value = options[name];
          return typeof value === "boolean" ? value : null;
        }
      },
      isButton() {
        return false;
      },
      isChatInputCommand() {
        return true;
      },
      async deferReply() {
        this.deferred = true;
      },
      async editReply(content: { content?: string } | string) {
        this.replied = true;
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      },
      async reply(content: { content?: string } | string) {
        this.replied = true;
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      },
      async followUp(content: { content?: string } | string) {
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      }
    }
  };
}

function createRuntime(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ type: string; payload?: unknown }> = [];
  const runtime = createDiscordRuntime({
    discord: { user: { id: "bot-1" } },
    config: {
      allowedUserIds: ["user-1"],
      defaultModel: "gpt-5.3-codex",
      sandboxMode: "workspace-write"
    },
    resolveRepoContext: (message: { channelId: string }) => ({
      repoChannelId: message.channelId,
      setup: {
        cwd: "/tmp/repo-one",
        model: "gpt-5.3-codex",
        mode: "repo",
        sandboxMode: "workspace-write",
        allowFileWrites: true
      }
    }),
    generalChannelId: "general-1",
    generalChannelName: "general",
    generalChannelCwd: "/tmp/general",
    getChannelSetups: () => ({
      "channel-1": {
        cwd: "/tmp/repo-one",
        model: "gpt-5.3-codex"
      }
    }),
    runManagedRouteCommand: async (message: { reply: (text: string) => Promise<unknown> }, options?: Record<string, unknown>) => {
      calls.push({ type: "bootstrap", payload: options ?? null });
      await message.reply("Resynced channels. discovered=3, created=1, moved=0, pruned=0, mapped=1");
    },
    shouldHandleAsSelfRestartRequest: () => false,
    requestSelfRestartFromDiscord: async () => {},
    collectImageAttachments: () => [],
    buildTurnInputFromMessage: async () => [],
    enqueuePrompt: () => {},
    getHelpText: () => "help text",
    isCommandSupportedForPlatform: () => true,
    handleCommand: async (message: { reply: (text: string) => Promise<unknown> }, content: string, context: unknown) => {
      calls.push({ type: "command", payload: { content, context } });
      await message.reply(`handled ${content}`);
    },
    handleInitRepoCommand: async (message: { reply: (text: string) => Promise<unknown> }, rest: string) => {
      calls.push({ type: "initrepo", payload: rest });
      await message.reply(`initrepo ${rest}`);
    },
    buildCommandTextFromInteraction: (interaction: { commandName: string; options: { getString: (name: string) => string | null } }) =>
      interaction.commandName === "status" ? "!status" : `!${interaction.commandName} ${interaction.options.getString("reason") ?? ""}`.trim(),
    handleSetPathCommand: async (message: { reply: (text: string) => Promise<unknown> }, rest: string) => {
      calls.push({ type: "setpath", payload: rest });
      await message.reply(`setpath ${rest}`);
    },
    registerSlashCommands: async () => ({ scope: "guild", guildId: "guild-1", count: 14 }),
    parseApprovalButtonCustomId: () => null,
    approvalButtonPrefix: "approval",
    pendingApprovals: new Map(),
    applyApprovalDecision: async () => ({ ok: true }),
    safeReply: async (message: { reply: (content: string) => Promise<unknown> }, content: string) => await message.reply(content),
    MessageFlags: { Ephemeral: 64 },
    ...overrides
  });

  return { runtime, calls };
}

describe("discord runtime slash commands", () => {
  test("routes /status through the existing command handler with a deferred reply", async () => {
    const { runtime, calls } = createRuntime();
    const { interaction, replies } = createInteraction("status");

    await runtime.handleInteraction(interaction);

    expect(interaction.deferred).toBe(true);
    expect(calls).toEqual([
      {
        type: "command",
        payload: {
          content: "!status",
          context: {
            repoChannelId: "channel-1",
            setup: {
              cwd: "/tmp/repo-one",
              model: "gpt-5.3-codex",
              mode: "repo",
              sandboxMode: "workspace-write",
              allowFileWrites: true
            }
          }
        }
      }
    ]);
    expect(replies).toEqual(["handled !status"]);
  });

  test("handles /resync before repo context lookup", async () => {
    const { runtime, calls } = createRuntime({
      resolveRepoContext: () => null
    });
    const { interaction } = createInteraction("resync");

    await runtime.handleInteraction(interaction);

    expect(calls).toEqual([{ type: "bootstrap", payload: { forceRebuild: false } }]);
  });
});
