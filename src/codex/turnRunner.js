import path from "node:path";
import { TURN_PHASE } from "../turns/lifecycle.js";
import { resolveRuntimeForAgent } from "../agents/setupResolution.js";
import { parseScopedRouteId } from "../bots/scopedRoutes.js";

export function createTurnRunner(deps) {
  const {
    queues,
    activeTurns,
    state,
    agentClientRegistry,
    config,
    safeReply,
    buildSandboxPolicyForTurn,
    isThreadNotFoundError,
    finalizeTurn,
    onActiveTurnsChanged,
    onTurnReconnectPending,
    onTurnCreated,
    onTurnAborted
  } = deps;

  /**
   * Get the agent client and runtime for a given setup and binding.
   * Priority: binding.runtime > agent runtime > global runtime
   */
  function getClientForSetupWithRuntime(setup, existingBinding = null, bot = null) {
    if (bot?.runtime === "claude" || bot?.runtime === "codex") {
      return {
        client: agentClientRegistry.getClient(bot.runtime),
        runtime: bot.runtime
      };
    }

    // If we have an existing binding with runtime, use that
    if (existingBinding?.runtime) {
      return {
        client: agentClientRegistry.getClient(existingBinding.runtime),
        runtime: existingBinding.runtime
      };
    }

    // Otherwise, resolve from agent configuration
    const agentId = setup?.resolvedAgentId || setup?.agentId || null;
    const runtime = resolveRuntimeForAgent(agentId, config);
    return {
      client: agentClientRegistry.getClient(runtime),
      runtime
    };
  }

  function shouldResetExistingBinding(existingBinding, setup, bot = null) {
    if (!existingBinding) {
      return false;
    }

    if (existingBinding?.cwd && path.resolve(existingBinding.cwd) !== path.resolve(setup.cwd)) {
      return true;
    }

    if (bot?.botId && existingBinding?.botId && existingBinding.botId !== bot.botId) {
      return true;
    }

    if (bot?.runtime && existingBinding?.runtime && existingBinding.runtime !== bot.runtime) {
      return true;
    }

    return false;
  }


  function enqueuePrompt(repoChannelId, job) {
    const queue = getQueue(repoChannelId);
    queue.jobs.push(job);
    if (!queue.running) {
      void processQueue(repoChannelId).catch((error) => {
        queue.running = false;
        console.error(`queue processing failed for ${repoChannelId}: ${formatErrorMessage(error)}`);
        // Clean up any orphaned turn for this channel
        const orphanedTurn = findActiveTurnByRepoChannel(repoChannelId);
        if (orphanedTurn) {
          console.warn(`cleaning up orphaned turn ${orphanedTurn.threadId} for channel ${repoChannelId}`);
          abortActiveTurn(orphanedTurn.threadId, error);
        }
      });
    }
  }

  function getQueue(repoChannelId) {
    const existing = queues.get(repoChannelId);
    if (existing) {
      return existing;
    }
    const created = { running: false, jobs: [] };
    queues.set(repoChannelId, created);
    return created;
  }

  async function processQueue(repoChannelId) {
    const queue = getQueue(repoChannelId);
    if (queue.running) {
      return;
    }
    queue.running = true;

    while (queue.jobs.length > 0) {
      const job = queue.jobs.shift();
      let startedThreadId = null;
      let turnPromise = null;
      const settleTimeoutMs = Number.isFinite(Number(process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS))
        ? Math.max(500, Math.floor(Number(process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS)))
        : 120_000;
      const configuredTurnMaxDurationMs = Number(process.env.DISCORD_TURN_MAX_DURATION_MS ?? "");
      const turnMaxDurationMs =
        Number.isFinite(configuredTurnMaxDurationMs) && configuredTurnMaxDurationMs > 0
          ? Math.max(1_000, Math.floor(configuredTurnMaxDurationMs))
          : null;
      try {
        let threadId = await ensureThreadId(repoChannelId, job.setup, job.bot);
        startedThreadId = threadId;

        const statusMessage = await safeReply(job.message, "⏳ Thinking...");
        if (!statusMessage) {
          throw new Error("Cannot send response in this channel (channel unavailable).");
        }

        // Get the agent client for this setup
        const existingBinding = state.getBinding(repoChannelId);
        const { client, runtime } = getClientForSetupWithRuntime(job.setup, existingBinding, job.bot);

        const rawModel = job.setup.resolvedModel ?? job.setup.model ?? config.defaultModel;
        // For Claude runtime, don't pass model if it's the codex default (Claude CLI should use its own default)
        const isClaudeRuntime = runtime === "claude";
        const isCodexDefaultModel = rawModel === "gpt-5.3-codex" || rawModel === "codex-default";
        const model = isClaudeRuntime && isCodexDefaultModel ? null : rawModel;
        const effort = config.defaultEffort;
        const approvalPolicy = normalizeApprovalPolicyForRuntime(config.approvalPolicy, runtime);
        const sandboxMode = job.setup.sandboxMode ?? config.sandboxMode;
        const sandboxPolicy = await buildSandboxPolicyForTurn(sandboxMode, job.setup.cwd);

        const runTurn = async (targetThreadId) => {
          startedThreadId = targetThreadId;
          const turn = createActiveTurn(targetThreadId, repoChannelId, statusMessage, job.setup.cwd, {
            allowFileWrites: job.setup.allowFileWrites !== false,
            requestId: job.requestId,
            sourceMessageId: job?.message?.id ?? null,
            platform: job.platform,
            runtime: runtime
          });
          turnPromise = turn.promise;

          const turnParams = {
            threadId: targetThreadId,
            cwd: job.setup.cwd,
            input: job.inputItems
          };
          if (model) {
            turnParams.model = model;
          }
          if (effort) {
            turnParams.effort = effort;
          }
          if (approvalPolicy) {
            turnParams.approvalPolicy = approvalPolicy;
          }
          if (sandboxPolicy) {
            turnParams.sandboxPolicy = sandboxPolicy;
          }

          await requestCodexWithReconnectRetry(() => client.request("turn/start", turnParams));
          if (!turnMaxDurationMs) {
            await turn.promise;
            return;
          }

          const completion = await Promise.race([
            turn.promise.then(
              () => ({ type: "resolved" }),
              (error) => ({ type: "rejected", error })
            ),
            delay(turnMaxDurationMs).then(() => ({ type: "timeout" }))
          ]);
          if (completion.type === "resolved") {
            return;
          }
          if (completion.type === "rejected") {
            throw completion.error;
          }

          const timeoutError = new Error(
            `Turn timed out after ${turnMaxDurationMs}ms. Interrupt the route or retry with a shorter prompt.`
          );
          throw timeoutError;
        };

        let reconnectRetryCount = 0;
        let reconnectLingerCount = 0;
        const maxTurnReconnectRetries = Number.isFinite(Number(process.env.DISCORD_TURN_RECONNECT_MAX_RETRIES))
          ? Math.max(1, Math.floor(Number(process.env.DISCORD_TURN_RECONNECT_MAX_RETRIES)))
          : 24;
        while (true) {
          try {
            await runTurn(threadId);
            break;
          } catch (error) {
            if (isThreadNotFoundError(error)) {
              abortActiveTurn(threadId, error);
              if (turnPromise) {
                await turnPromise.catch(() => {});
              }

              state.clearBinding(repoChannelId);
              await state.save();

              threadId = await ensureThreadId(repoChannelId, job.setup, job.bot);
              continue;
            }

            const message = String(error?.message ?? "");
            if (isTransientReconnectError(message) && reconnectRetryCount < maxTurnReconnectRetries) {
              reconnectRetryCount += 1;
              const settlement = turnPromise ? await waitForTurnSettlement(turnPromise, settleTimeoutMs) : "timeout";
              if (settlement === "resolved") {
                break;
              }
              const tracker = activeTurns.get(threadId);
              const hasProgress = hasTurnProgress(tracker);
              if (!hasProgress) {
                if (activeTurns.has(threadId)) {
                  abortActiveTurn(threadId, error);
                }
                if (turnPromise) {
                  await turnPromise.catch(() => {});
                }
                await delay(Math.min(10_000, 1_000 * reconnectRetryCount));
                threadId = await ensureThreadId(repoChannelId, job.setup, job.bot);
                continue;
              }
              // Progress already observed: do not replay same prompt and risk duplicate output.
              reconnectLingerCount += 1;
              onTurnReconnectPending?.(threadId, {
                attempt: reconnectLingerCount,
                message
              });
              const lingerSettlement = turnPromise ? await waitForTurnSettlement(turnPromise, settleTimeoutMs) : "timeout";
              if (lingerSettlement === "resolved") {
                break;
              }
              throw error;
            }

            throw error;
          }
        }
      } catch (error) {
        if (startedThreadId && activeTurns.has(startedThreadId)) {
          await finalizeTurn(startedThreadId, error);
          if (turnPromise) {
            await turnPromise.catch(() => {});
          }
        } else if (!turnPromise) {
          await safeReply(job.message, `❌ ${error.message}`);
        }
      }
    }

    queue.running = false;
  }

  async function requestCodexWithReconnectRetry(requestFn) {
    const configuredMaxAttempts = Number(process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS ?? "");
    const maxAttempts =
      Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
        ? Math.floor(configuredMaxAttempts)
        : 60;
    let attempt = 1;
    while (true) {
      try {
        return await requestFn();
      } catch (error) {
        const message = String(error?.message ?? "");
        const shouldRetry = isTransientReconnectError(message) && attempt < maxAttempts;
        if (!shouldRetry) {
          throw error;
        }
        await delay(Math.min(10_000, 500 * attempt));
        attempt += 1;
      }
    }
  }

  async function ensureThreadId(repoChannelId, setup, bot = null) {
    let existingBinding = state.getBinding(repoChannelId);
    let existingThreadId = existingBinding?.codexThreadId ?? null;
    if (shouldResetExistingBinding(existingBinding, setup, bot)) {
      state.clearBinding(repoChannelId);
      await state.save();
      existingBinding = null;
      existingThreadId = null;
    }

    // If existingThreadId is a temp ID (from a previous incomplete Claude session),
    // clear it and start fresh - temp IDs cannot be resumed
    if (existingThreadId && existingThreadId.startsWith("temp-")) {
      console.log(`[turnRunner] Clearing temp thread ID ${existingThreadId}, cannot resume`);
      state.clearBinding(repoChannelId);
      await state.save();
      existingBinding = null;
      existingThreadId = null;
    }

    const sandboxMode = setup.sandboxMode ?? config.sandboxMode;

    // Get the agent client for this setup
    const { client, runtime: runtimeForApproval } = getClientForSetupWithRuntime(setup, existingBinding, bot);
    const approvalPolicy = normalizeApprovalPolicyForRuntime(config.approvalPolicy, runtimeForApproval);

    if (existingThreadId) {
      try {
        const resumeParams = {
          threadId: existingThreadId,
          cwd: setup.cwd
        };
        if (approvalPolicy) {
          resumeParams.approvalPolicy = approvalPolicy;
        }
        if (sandboxMode) {
          resumeParams.sandbox = sandboxMode;
        }
        await requestCodexWithReconnectRetry(() => client.request("thread/resume", resumeParams));
        return existingThreadId;
      } catch (error) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }
        state.clearBinding(repoChannelId);
        await state.save();
      }
    }

    const startParams = { cwd: setup.cwd };
    // Resolve runtime for model filtering
    const requestedAgentId = setup?.agentId || setup?.resolvedAgentId || null;
    const runtimeForStart =
      bot?.runtime === "claude" || bot?.runtime === "codex" ? bot.runtime : resolveRuntimeForAgent(requestedAgentId, config);
    const rawModelForStart = setup.resolvedModel ?? setup.model ?? config.defaultModel;
    const isClaudeRuntimeForStart = runtimeForStart === "claude";
    const isCodexDefaultModelForStart = rawModelForStart === "gpt-5.3-codex" || rawModelForStart === "codex-default";
    const modelForStart = isClaudeRuntimeForStart && isCodexDefaultModelForStart ? null : rawModelForStart;
    const effort = config.defaultEffort;
    if (modelForStart) {
      startParams.model = modelForStart;
    }
    if (effort) {
      startParams.effort = effort;
    }
    if (approvalPolicy) {
      startParams.approvalPolicy = approvalPolicy;
    }
    if (sandboxMode) {
      startParams.sandbox = sandboxMode;
    }

    const result = await requestCodexWithReconnectRetry(() => client.request("thread/start", startParams));
    const threadId = result?.thread?.id;
    const bindingAgentId =
      requestedAgentId && resolveRuntimeForAgent(requestedAgentId, config) === runtimeForStart ? requestedAgentId : undefined;
    // For Claude runtime, threadId may be null for new sessions
    // The real session ID will come from system_init notification
    if (!threadId) {
      // Generate a temporary ID for tracking - will be updated when session starts
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      console.log(`[turnRunner] thread/start returned null, using temp ID: ${tempId}`);

      // Save binding with temp ID so onSessionIdUpdate can find and update it
      const runtimeForBinding = runtimeForStart;
      state.setBinding(repoChannelId, {
        codexThreadId: tempId,
        repoChannelId,
        cwd: setup.cwd,
        runtime: runtimeForBinding,
        agentId: bindingAgentId,
        ...buildBindingMetadata(repoChannelId, bot)
      });
      await state.save();

      return tempId;
    }

    // Determine the runtime for this binding (reuse agentId from earlier in function)
    const runtimeForBinding = runtimeForStart;

    state.setBinding(repoChannelId, {
      codexThreadId: threadId,
      repoChannelId,
      cwd: setup.cwd,
      runtime: runtimeForBinding,
      agentId: bindingAgentId,
      ...buildBindingMetadata(repoChannelId, bot)
    });
    await state.save();
    return threadId;
  }

  // Output buffer configuration
const OUTPUT_BUFFER_MAX_LINES = 500;

function createActiveTurn(threadId, repoChannelId, message, cwd, options = {}) {
    if (activeTurns.has(threadId)) {
      throw new Error("Turn already active for this thread");
    }

    console.log(`[turnRunner] createActiveTurn: threadId=${threadId}, repoChannelId=${repoChannelId}, platform=${options.platform}`);

    let resolveTurn;
    let rejectTurn;
    let promiseSettled = false;
    const promise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    activeTurns.set(threadId, {
      threadId,
      repoChannelId,
      statusMessage: message,
      statusMessageId: message.id,
      channel: message.channel,
      cwd: typeof cwd === "string" && cwd ? cwd : null,
      lifecyclePhase: TURN_PHASE.RUNNING,
      allowFileWrites: options.allowFileWrites !== false,
      requestId: typeof options.requestId === "string" && options.requestId ? options.requestId : null,
      sourceMessageId: typeof options.sourceMessageId === "string" && options.sourceMessageId ? options.sourceMessageId : null,
      platform: typeof options.platform === "string" && options.platform ? options.platform : null,
      runtime: typeof options.runtime === "string" && options.runtime ? options.runtime : "codex",
      sentAttachmentKeys: new Set(),
      seenAttachmentIssueKeys: new Set(),
      attachmentIssueCount: 0,
      firstToolCallAt: 0,
      lastToolCompletedAt: 0,
      hasToolCall: false,
      hasSummaryImageAttachment: false,
      workingMessage: null,
      workingMessageId: null,
      workingMessageCreatePromise: null,
      workingTicker: null,
      thinkingStartedAt: Date.now(),
      thinkingTicker: null,
      fullText: "",
      seenDelta: false,
      currentStatusLine: "⏳ Thinking...",
      lastRenderedContent: "",
      streamedTextOffset: 0,
      streamedSummaryText: "",
      completed: false,
      failed: false,
      failureMessage: "",
      fileChangeSummary: new Map(),
      statusSyntheticCounter: 0,
      flushTimer: null,
      lastFlushAt: 0,
      lastTurnActivityAt: Date.now(),
      turnCompletionRequested: false,
      turnCompletionRequestedAt: 0,
      turnFinalizeTimer: null,
      activeLifecycleItemKeys: new Set(),
      completedLifecycleItemKeys: new Set(),
      finalizing: false,
      // Output buffer for /screen and /log commands
      outputBuffer: [],
      outputBufferTimestamps: [],
      outputBufferMaxLines: OUTPUT_BUFFER_MAX_LINES,
      resolve(value) {
        if (promiseSettled) {
          return;
        }
        promiseSettled = true;
        resolveTurn(value);
      },
      reject(reason) {
        if (promiseSettled) {
          return;
        }
        promiseSettled = true;
        rejectTurn(reason);
      }
    });
    runDetachedCallback(`onActiveTurnsChanged failed for ${threadId}`, () => onActiveTurnsChanged?.());
    runDetachedCallback(`onTurnCreated failed for ${threadId}`, () => onTurnCreated?.(activeTurns.get(threadId)));

    return { promise };
  }

  function abortActiveTurn(threadId, error) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }

    if (tracker.flushTimer) {
      clearTimeout(tracker.flushTimer);
      tracker.flushTimer = null;
    }
    if (tracker.turnFinalizeTimer) {
      clearTimeout(tracker.turnFinalizeTimer);
      tracker.turnFinalizeTimer = null;
    }
    if (tracker.workingTicker) {
      clearInterval(tracker.workingTicker);
      tracker.workingTicker = null;
    }
    if (tracker.thinkingTicker) {
      clearInterval(tracker.thinkingTicker);
      tracker.thinkingTicker = null;
    }

    activeTurns.delete(threadId);
    runDetachedCallback(`onActiveTurnsChanged failed for ${threadId}`, () => onActiveTurnsChanged?.());
    tracker.lifecyclePhase = TURN_PHASE.CANCELLED;
    tracker.failureMessage = String(error?.message ?? tracker.failureMessage ?? "Turn aborted");
    runDetachedCallback(`onTurnAborted failed for ${threadId}`, () => onTurnAborted?.(threadId, tracker));
    tracker.reject(error ?? new Error("Turn aborted"));
  }

  function findActiveTurnByRepoChannel(repoChannelId) {
    for (const tracker of activeTurns.values()) {
      if (tracker.repoChannelId === repoChannelId) {
        return tracker;
      }
    }
    return null;
  }

  return {
    enqueuePrompt,
    getQueue,
    processQueue,
    ensureThreadId,
    createActiveTurn,
    abortActiveTurn,
    findActiveTurnByRepoChannel
  };
}

function buildBindingMetadata(repoChannelId, bot = null) {
  const scopedRoute = parseScopedRouteId(repoChannelId);
  return {
    ...(bot?.botId ? { botId: bot.botId } : scopedRoute?.botId ? { botId: scopedRoute.botId } : {}),
    ...(bot?.platform ? { platform: bot.platform } : {}),
    ...(scopedRoute?.externalRouteId ? { externalRouteId: scopedRoute.externalRouteId } : {})
  };
}

function runDetachedCallback(label, callback) {
  void Promise.resolve()
    .then(callback)
    .catch((error) => {
      console.error(`${label}: ${formatErrorMessage(error)}`);
    });
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function normalizeApprovalPolicyForRuntime(approvalPolicy, runtime) {
  if ((approvalPolicy === "bypass" || approvalPolicy === "skip-all") && runtime === "codex") {
    return "never";
  }
  return approvalPolicy;
}

function isTransientReconnectError(message) {
  if (!message) {
    return false;
  }
  return (
    /reconnecting\.\.\.\s*\d+\/\d+/i.test(message) ||
    /temporarily unavailable/i.test(message) ||
    /connection (?:reset|closed|lost)/i.test(message) ||
    /econnreset/i.test(message) ||
    /stream disconnected before completion/i.test(message) ||
    /error sending request for url/i.test(message)
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasTurnProgress(tracker) {
  if (!tracker || typeof tracker !== "object") {
    return false;
  }
  if (tracker.seenDelta) {
    return true;
  }
  if (typeof tracker.fullText === "string" && tracker.fullText.trim().length > 0) {
    return true;
  }
  if (
    typeof tracker.currentStatusLine === "string" &&
    !tracker.currentStatusLine.trim().startsWith("⏳ Thinking...")
  ) {
    return true;
  }
  return false;
}

async function waitForTurnSettlement(turnPromise, timeoutMs) {
  try {
    const settled = await Promise.race([
      turnPromise.then(() => "resolved").catch(() => "rejected"),
      delay(timeoutMs).then(() => "timeout")
    ]);
    return settled;
  } catch {
    return "timeout";
  }
}
