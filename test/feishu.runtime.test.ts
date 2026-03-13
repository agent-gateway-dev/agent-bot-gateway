import { afterEach, describe, expect, test } from "bun:test";
import { createFeishuRuntime } from "../src/feishu/runtime.js";
import { makeFeishuRouteId } from "../src/feishu/ids.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("feishu runtime", () => {
  test("returns identifiers for /where before a chat is bound", async () => {
    const replies: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      replies.push(body.content ?? "");
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_where" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-where-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_where_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_where_1",
          chat_id: "oc_where_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/where" }),
          mentions: []
        }
      }
    });

    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("platform: `feishu`");
    expect(replies[0]).toContain("chat_id: `oc_where_1`");
    expect(replies[0]).toContain("route_id: `feishu:oc_where_1`");
    expect(replies[0]).toContain("sender_open_id: `ou_where_1`");
    expect(replies[0]).toContain("binding: none");
  });

  test("routes /status commands through the shared command handler", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const routeId = makeFeishuRouteId("oc_repo_1");
    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "verify-token",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async (message: { reply: (text: string) => Promise<unknown> }, content: string, context: unknown) => {
        calls.push({ type: "command", payload: { content, context } });
        await message.reply(`handled ${content}`);
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      token: "verify-token",
      header: {
        event_id: "evt-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_1",
          chat_id: "oc_repo_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/status" }),
          mentions: []
        }
      }
    });

    expect(calls).toEqual([
      {
        type: "command",
        payload: {
          content: "!status",
          context: {
            repoChannelId: routeId,
            setup: {
              cwd: "/tmp/repo",
              model: "gpt-5.3-codex",
              mode: "repo",
              sandboxMode: "workspace-write",
              allowFileWrites: true
            }
          }
        }
      }
    ]);
  });

  test("queues plain text prompts for mapped chats", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_2");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_2" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-two",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-2",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_2" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_2",
          chat_id: "oc_repo_2",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "请帮我看一下这个仓库" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "请帮我看一下这个仓库"
      }
    ]);
  });

  test("starts long-connection transport and routes sdk events through the same prompt pipeline", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_long_1");
    const calls: Array<{ type: string; payload: unknown }> = [];
    let registeredHandles: Record<string, (event: unknown) => Promise<void>> = {};

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-long",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null,
      feishuSdk: {
        LoggerLevel: { warn: 2 },
        defaultHttpInstance: { defaults: {} },
        EventDispatcher: class {
          register(handles: Record<string, (event: unknown) => Promise<void>>) {
            registeredHandles = handles;
            return this;
          }
        },
        WSClient: class {
          constructor(options: unknown) {
            calls.push({ type: "ws-client", payload: options });
          }

          async start({ eventDispatcher }: { eventDispatcher: unknown }) {
            calls.push({ type: "ws-start", payload: eventDispatcher });
          }

          close() {
            calls.push({ type: "ws-close", payload: null });
          }
        }
      }
    });

    const summary = await runtime.start();
    expect(summary).toEqual({
      started: true,
      transport: "long-connection"
    });
    expect(runtime.transport).toBe("long-connection");
    expect(runtime.webhookPath).toBe("");
    expect(calls).toHaveLength(2);
    expect(typeof registeredHandles["im.message.receive_v1"]).toBe("function");

    await registeredHandles["im.message.receive_v1"]({
      sender: {
        sender_id: { open_id: "ou_user_long_1" },
        sender_type: "user"
      },
      message: {
        message_id: "om_in_long_1",
        chat_id: "oc_repo_long_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "帮我看下这个变更" }),
        mentions: []
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "帮我看下这个变更"
      }
    ]);
  });

  test("routes /setpath in an unbound chat through the shared setpath handler", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      handleSetPathCommand: async (message: { channelId: string }, rest: string) => {
        calls.push({ type: "setpath", payload: { routeId: message.channelId, rest } });
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-setpath-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_3" },
          sender_type: "user"
        },
        message: {
          message_id: "om_setpath_1",
          chat_id: "oc_setpath_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/setpath /tmp/another-repo" }),
          mentions: []
        }
      }
    });

    expect(calls).toEqual([
      {
        type: "setpath",
        payload: {
          routeId: "feishu:oc_setpath_1",
          rest: "/tmp/another-repo"
        }
      }
    ]);
  });
});
