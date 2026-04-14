import { describe, expect, test } from "bun:test";
import { createTurnRunner } from "../src/codex/turnRunner.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 800, stepMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await delay(stepMs);
  }
  return false;
}

function createHarness() {
  const queues = new Map();
  const activeTurns = new Map<
    string,
    {
      fullText?: string;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }
  >();
  const stateByChannel = new Map<string, Record<string, unknown>>();
  const setBindingCalls: Array<{ repoChannelId: string; binding: Record<string, unknown> }> = [];
  const getClientCalls: string[] = [];
  const requestCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];

  const state = {
    getBinding(repoChannelId: string) {
      return stateByChannel.get(repoChannelId) ?? null;
    },
    setBinding(repoChannelId: string, binding: Record<string, unknown>) {
      setBindingCalls.push({ repoChannelId, binding: { ...binding } });
      stateByChannel.set(repoChannelId, { ...binding });
    },
    clearBinding(repoChannelId: string) {
      stateByChannel.delete(repoChannelId);
    },
    async save() {}
  };

  const channel = {
    id: "123",
    isTextBased: () => true
  };

  const safeReply = async () => ({
    id: "status-1",
    channel,
    async edit() {}
  });

  const client = {
    async request(method: string, params?: Record<string, unknown>) {
      requestCalls.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        return {};
      }
      if (method === "thread/resume") {
        return {};
      }
      return {};
    }
  };

  const agentClientRegistry = {
    getClient(runtime: string) {
      getClientCalls.push(runtime);
      return client;
    }
  };

  const finalizeTurn = async (threadId: string, error: Error | null) => {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    activeTurns.delete(threadId);
    if (error) {
      tracker.reject(error);
      return;
    }
    tracker.resolve(tracker.fullText ?? "");
  };

  return {
    queues,
    activeTurns,
    state,
    setBindingCalls,
    getClientCalls,
    requestCalls,
    safeReply,
    agentClientRegistry,
    finalizeTurn
  };
}

describe("turnRunner multi-bot", () => {
  test("maps bypass approval to never for codex runtime", async () => {
    const harness = createHarness();
    const runner = createTurnRunner({
      queues: harness.queues,
      activeTurns: harness.activeTurns,
      state: harness.state,
      agentClientRegistry: harness.agentClientRegistry,
      config: {
        runtime: "codex",
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "bypass",
        sandboxMode: "workspace-write",
        agents: {
          "codex-default": {
            model: "gpt-5.3-codex",
            runtime: "codex",
            enabled: true
          }
        }
      },
      safeReply: harness.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: harness.finalizeTurn,
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {}
    });

    runner.enqueuePrompt("bot:discord-main:route:123", {
      message: { id: "message-1", channelId: "123" },
      bot: {
        botId: "discord-main",
        platform: "discord",
        runtime: "codex"
      },
      setup: {
        cwd: "/tmp/repo-a",
        agentId: "codex-default",
        model: "gpt-5.3-codex"
      },
      inputItems: [{ type: "text", text: "hello" }]
    });

    const seenTracker = await waitUntil(() => harness.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = harness.activeTurns.get("thread-1");
    tracker?.resolve("done");

    const queueSettled = await waitUntil(() => !runner.getQueue("bot:discord-main:route:123").running);
    expect(queueSettled).toBe(true);
    expect(harness.requestCalls).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({ approvalPolicy: "never" })
    });
  });

  test("preserves bypass approval for claude runtime", async () => {
    const harness = createHarness();
    const runner = createTurnRunner({
      queues: harness.queues,
      activeTurns: harness.activeTurns,
      state: harness.state,
      agentClientRegistry: harness.agentClientRegistry,
      config: {
        runtime: "codex",
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "bypass",
        sandboxMode: "workspace-write",
        agents: {
          "claude-default": {
            runtime: "claude",
            enabled: true
          }
        }
      },
      safeReply: harness.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: harness.finalizeTurn,
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {}
    });

    runner.enqueuePrompt("bot:feishu-claude-main:route:123", {
      message: { id: "message-1", channelId: "123" },
      bot: {
        botId: "feishu-claude-main",
        platform: "feishu",
        runtime: "claude"
      },
      setup: {
        cwd: "/tmp/repo-a",
        agentId: "claude-default"
      },
      inputItems: [{ type: "text", text: "hello" }]
    });

    const seenTracker = await waitUntil(() => harness.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = harness.activeTurns.get("thread-1");
    tracker?.resolve("done");

    const queueSettled = await waitUntil(() => !runner.getQueue("bot:feishu-claude-main:route:123").running);
    expect(queueSettled).toBe(true);
    expect(harness.requestCalls).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({ approvalPolicy: "bypass" })
    });
  });
  test("uses bot runtime instead of global runtime fallback", async () => {
    const harness = createHarness();
    const runner = createTurnRunner({
      queues: harness.queues,
      activeTurns: harness.activeTurns,
      state: harness.state,
      agentClientRegistry: harness.agentClientRegistry,
      config: {
        runtime: "codex",
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        agents: {
          "codex-default": {
            model: "gpt-5.3-codex",
            runtime: "codex",
            enabled: true
          }
        }
      },
      safeReply: harness.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: harness.finalizeTurn,
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {}
    });

    runner.enqueuePrompt("bot:discord-main:route:123", {
      message: { id: "message-1", channelId: "123" },
      bot: {
        botId: "discord-main",
        platform: "discord",
        runtime: "claude"
      },
      setup: {
        cwd: "/tmp/repo-a",
        agentId: "codex-default",
        model: "gpt-5.3-codex"
      },
      inputItems: [{ type: "text", text: "hello" }]
    });

    const seenTracker = await waitUntil(() => harness.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = harness.activeTurns.get("thread-1");
    tracker?.resolve("done");

    const queueSettled = await waitUntil(() => !runner.getQueue("bot:discord-main:route:123").running);
    expect(queueSettled).toBe(true);
    expect(harness.getClientCalls).toContain("claude");
  });

  test("persists binding with bot metadata and scoped route id", async () => {
    const harness = createHarness();
    const runner = createTurnRunner({
      queues: harness.queues,
      activeTurns: harness.activeTurns,
      state: harness.state,
      agentClientRegistry: harness.agentClientRegistry,
      config: {
        runtime: "codex",
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        agents: {
          "claude-default": {
            model: "claude-sonnet-4-6",
            runtime: "claude",
            enabled: true
          }
        }
      },
      safeReply: harness.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: harness.finalizeTurn,
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {}
    });

    runner.enqueuePrompt("bot:discord-main:route:123", {
      message: { id: "message-1", channelId: "123" },
      bot: {
        botId: "discord-main",
        platform: "discord",
        runtime: "claude"
      },
      setup: {
        cwd: "/tmp/repo-a",
        agentId: "claude-default",
        model: "claude-sonnet-4-6"
      },
      inputItems: [{ type: "text", text: "hello" }]
    });

    const seenTracker = await waitUntil(() => harness.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = harness.activeTurns.get("thread-1");
    tracker?.resolve("done");

    const queueSettled = await waitUntil(() => !runner.getQueue("bot:discord-main:route:123").running);
    expect(queueSettled).toBe(true);
    expect(harness.setBindingCalls).toContainEqual({
      repoChannelId: "bot:discord-main:route:123",
      binding: expect.objectContaining({
        botId: "discord-main",
        runtime: "claude",
        repoChannelId: "bot:discord-main:route:123"
      })
    });
  });

  test("clears mismatched runtime binding before resuming a bot-scoped route", async () => {
    const harness = createHarness();
    const clearedBindings: string[] = [];
    harness.state.clearBinding = (repoChannelId: string) => {
      clearedBindings.push(repoChannelId);
    };
    harness.state.getBinding = (repoChannelId: string) => {
      if (repoChannelId === "bot:feishu-default:route:123") {
        return {
          codexThreadId: "claude-session-1",
          runtime: "claude",
          agentId: "claude-default",
          cwd: "/tmp/repo-a"
        };
      }
      return null;
    };

    const runner = createTurnRunner({
      queues: harness.queues,
      activeTurns: harness.activeTurns,
      state: harness.state,
      agentClientRegistry: harness.agentClientRegistry,
      config: {
        runtime: "codex",
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        agents: {
          "claude-default": {
            runtime: "claude",
            enabled: true
          },
          "codex-default": {
            runtime: "codex",
            enabled: true,
            model: "gpt-5.3-codex"
          }
        }
      },
      safeReply: harness.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: harness.finalizeTurn,
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {}
    });

    runner.enqueuePrompt("bot:feishu-default:route:123", {
      message: { id: "message-1", channelId: "123" },
      bot: {
        botId: "feishu-default",
        platform: "feishu",
        runtime: "codex"
      },
      setup: {
        cwd: "/tmp/repo-a",
        resolvedAgentId: "claude-default"
      },
      inputItems: [{ type: "text", text: "hello" }]
    });

    const seenTracker = await waitUntil(() => harness.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = harness.activeTurns.get("thread-1");
    tracker?.resolve("done");

    const queueSettled = await waitUntil(() => !runner.getQueue("bot:feishu-default:route:123").running);
    expect(queueSettled).toBe(true);
    expect(clearedBindings).toContain("bot:feishu-default:route:123");
    expect(harness.requestCalls.some(({ method }) => method === "thread/resume")).toBe(false);
    expect(harness.requestCalls).toContainEqual({
      method: "thread/start",
      params: expect.objectContaining({ cwd: "/tmp/repo-a" })
    });
  });
});
