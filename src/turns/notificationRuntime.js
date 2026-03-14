import { collectLikelyLocalPathsFromText, extractAttachmentCandidates } from "../attachments/service.js";
import { isMissingRolloutPathError } from "../app/runtimeUtils.js";

export function createNotificationRuntime(deps) {
  const {
    activeTurns,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendInferredAttachmentsFromText,
    recordFileChanges,
    buildFileDiffSection,
    sanitizeSummaryForDiscord = (text) => String(text ?? "").trim(),
    sendChunkedToChannel,
    normalizeFinalSummaryText,
    truncateStatusText,
    isTransientReconnectErrorMessage,
    safeSendToChannel,
    truncateForDiscordMessage,
    discordMaxMessageLength,
    debugLog,
    writeHeartbeatFile,
    onTurnFinalized,
    turnCompletionQuietMs = 3000,
    turnCompletionMaxWaitMs = 12000,
    reconnectSettleQuietMs = 5000
  } = deps;

  async function handleNotification({ method, params }) {
    const normalized = normalizeCodexNotification({ method, params });

    if (normalized.kind === "agent_delta") {
      const threadId = normalized.threadId;
      const delta = normalized.delta;
      if (!threadId || !delta) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      await ensureThinkingStage(tracker);
      transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      debugLog("item-delta", "agent delta", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        deltaLength: delta.length
      });
      appendTrackerText(tracker, delta, { fromDelta: true });
      return;
    }

    if (normalized.kind === "item_lifecycle") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      const item = normalized.item;
      const state = normalized.state;
      updateLifecycleItemState(tracker, item, state);
      if (isToolCallItemType(item?.type)) {
        noteToolCallObserved(tracker);
        await ensureWorkingStage(tracker);
      }
      await ensureThinkingStage(tracker);
      if (state === "started") {
        transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      }

      if (tracker.turnCompletionRequested) {
        scheduleTurnFinalizeWhenSettled(threadId, tracker);
      }
      debugLog("item-event", "item lifecycle", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        state,
        itemType: item?.type,
        itemId: item?.id ?? null
      });

      if (item?.type === "fileChange" && method === "item/completed") {
        recordFileChanges(tracker, item);
      }

      if (state === "completed") {
        if (item?.type === "imageView") {
          queueAttachmentCandidatesForLater(tracker, item);
        }
      }

      if (state === "started") {
        return;
      }

      const messageText = extractAgentMessageText(item);
      if (!messageText) {
        return;
      }
      if (tracker.seenDelta || tracker.fullText.length > 0) {
        return;
      }
      appendTrackerText(tracker, messageText, { fromDelta: false });
      return;
    }

    if (normalized.kind === "turn_completed") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      tracker.turnCompletionRequested = true;
      if (!tracker.turnCompletionRequestedAt) {
        tracker.turnCompletionRequestedAt = Date.now();
      }
      scheduleTurnFinalizeWhenSettled(threadId, tracker);
      return;
    }

    if (normalized.kind === "error") {
      const threadId = normalized.threadId;
      const message = normalized.errorMessage;
      if (threadId) {
        const tracker = activeTurns.get(threadId);
        if (tracker && isTransientReconnectErrorMessage(message)) {
          noteReconnectObserved(tracker);
          markTurnReconnecting(tracker, "🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...");
          debugLog("transport", "transient reconnect while turn active", {
            threadId,
            turnId: threadId,
            discordMessageId: tracker.statusMessageId ?? null,
            message: truncateStatusText(String(message ?? ""), 200)
          });
          return;
        }
        if (isMissingRolloutPathError(message)) {
          debugLog("transport", "ignoring missing rollout path error", {
            threadId,
            turnId: threadId,
            discordMessageId: tracker?.statusMessageId ?? null,
            message: truncateStatusText(String(message ?? ""), 200)
          });
          return;
        }
        await finalizeTurn(threadId, new Error(message));
      }
    }
  }

  function onTurnReconnectPending(threadId, context = {}) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    const attempt = Number.isFinite(Number(context.attempt)) ? Number(context.attempt) : 1;
    const suffix = attempt > 1 ? ` (retry ${attempt})` : "";
    markTurnReconnecting(
      tracker,
      `🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...${suffix}`
    );
  }

  function scheduleFlush(tracker) {
    if (tracker.flushTimer) {
      return;
    }
    const elapsed = Date.now() - tracker.lastFlushAt;
    const delay = Math.max(0, 1200 - elapsed);
    tracker.flushTimer = setTimeout(() => {
      tracker.flushTimer = null;
      void flushTrackerParagraphs(tracker, { force: false }).catch((error) => {
        console.error(`tracker flush failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, delay);
  }

  async function flushTrackerParagraphs(tracker, { force }) {
    if (!force && !activeTurns.has(tracker.threadId)) {
      return;
    }
    const content = buildTrackerMessageContent(tracker);
    await editTrackerMessage(tracker, content);
    tracker.lastFlushAt = Date.now();
  }

  async function finalizeTurn(threadId, error) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    if (tracker.finalizing) {
      return;
    }
    if (!transitionTurnPhase(tracker, TURN_PHASE.FINALIZING)) {
      return;
    }
    tracker.finalizing = true;
    clearTurnFinalizeTimer(tracker);
    tracker.turnCompletionRequested = false;
    let finalError = error ? toError(error) : null;
    let resolvedText = null;

    if (tracker.flushTimer) {
      clearTimeout(tracker.flushTimer);
      tracker.flushTimer = null;
    }

    try {
      clearThinkingTicker(tracker);
      if (finalError) {
        tracker.failed = true;
        tracker.completed = true;
        tracker.failureMessage = finalError.message;
        transitionTurnPhase(tracker, TURN_PHASE.FAILED);
        if (isTransientReconnectErrorMessage(finalError.message)) {
          pushStatusLine(
            tracker,
            "🔄 Temporary reconnect while processing did not recover in time. Please retry."
          );
        } else {
          pushStatusLine(tracker, `❌ Error: ${truncateStatusText(finalError.message, 220)}`);
        }
        await safeSendToChannel(tracker.channel, `❌ Error: ${truncateStatusText(finalError.message, 220)}`).catch((sendError) => {
          console.error(`failed to send turn error for ${threadId}: ${formatErrorMessage(sendError)}`);
        });
        return;
      }

      tracker.completed = true;
      transitionTurnPhase(tracker, TURN_PHASE.DONE);
      await finalizeUxFlowStages(tracker);

      tracker.fullText = normalizeFinalSummaryText(tracker.fullText);
      const summaryTextForDiscord = sanitizeSummaryForDiscord(tracker.fullText);
      const diffBlock = buildFileDiffSection(tracker);
      const pendingAttachmentPaths = tracker.pendingAttachmentPaths ? [...tracker.pendingAttachmentPaths] : [];
      const attachmentHintText =
        pendingAttachmentPaths.length > 0
          ? `${tracker.fullText}\n${pendingAttachmentPaths.join("\n")}`
          : tracker.fullText;
      const inferredSummaryPaths = collectLikelyLocalPathsFromText(attachmentHintText);
      debugLog("summary", "prepared summary text", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        rawLength: tracker.fullText.length,
        sanitizedLength: summaryTextForDiscord.length,
        rawPreview: summarizeForDebug(tracker.fullText, 180),
        sanitizedPreview: summarizeForDebug(summaryTextForDiscord, 180),
        inferredSummaryPathCount: inferredSummaryPaths.length,
        inferredSummaryPaths: inferredSummaryPaths.slice(0, 8)
      });
      if (summaryTextForDiscord) {
        await sendChunkedToChannel(tracker.channel, summaryTextForDiscord);
      }
      const sentImages = await maybeSendInferredAttachmentsFromText(tracker, attachmentHintText);
      tracker.hasSummaryImageAttachment = Number(sentImages) > 0;
      debugLog("attachments", "inferred attachment send complete", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        inferredSentCount: Number(sentImages) || 0,
        telemetry: tracker.attachmentTelemetry ?? null
      });
      if (diffBlock) {
        await sendChunkedToChannel(tracker.channel, diffBlock);
      }
      resolvedText = tracker.fullText;
    } catch (caughtError) {
      const normalizedError = toError(caughtError);
      if (!finalError) {
        finalError = normalizedError;
        tracker.failed = true;
        tracker.completed = true;
        tracker.failureMessage = normalizedError.message;
        transitionTurnPhase(tracker, TURN_PHASE.FAILED);
        pushStatusLine(tracker, `❌ Error: ${truncateStatusText(normalizedError.message, 220)}`);
        await safeSendToChannel(tracker.channel, `❌ Error: ${truncateStatusText(normalizedError.message, 220)}`).catch(
          (sendError) => {
            console.error(`failed to send turn error for ${threadId}: ${formatErrorMessage(sendError)}`);
          }
        );
      }
      console.error(`turn finalization failed for ${threadId}: ${formatErrorMessage(normalizedError)}`);
    } finally {
      clearWorkingTicker(tracker);
      clearThinkingTicker(tracker);
      activeTurns.delete(threadId);
      if (finalError) {
        settleTracker(tracker, "reject", finalError);
      } else {
        settleTracker(tracker, "resolve", resolvedText ?? tracker.fullText);
      }
      if (typeof onTurnFinalized === "function") {
        try {
          await onTurnFinalized(tracker);
        } catch (finalizeError) {
          console.error(`onTurnFinalized failed for ${threadId}: ${formatErrorMessage(finalizeError)}`);
        }
      }
      try {
        await writeHeartbeatFile();
      } catch (heartbeatError) {
        console.error(`failed to write heartbeat after turn ${threadId}: ${formatErrorMessage(heartbeatError)}`);
      }
    }
  }

  function queueAttachmentCandidatesForLater(tracker, item) {
    if (!tracker || !item || typeof item !== "object") {
      return;
    }
    if (!tracker.pendingAttachmentPaths) {
      tracker.pendingAttachmentPaths = new Set();
    }
    const candidates = extractAttachmentCandidates(item, { attachmentInferFromText: true });
    for (const candidate of candidates) {
      const value = typeof candidate?.path === "string" ? candidate.path.trim() : "";
      if (value) {
        tracker.pendingAttachmentPaths.add(value);
      }
    }
  }

  function noteTurnActivity(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    tracker.lastTurnActivityAt = Date.now();
  }

  function noteToolCallObserved(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    const now = Date.now();
    tracker.hasToolCall = true;
    if (!Number.isFinite(tracker.firstToolCallAt) || tracker.firstToolCallAt <= 0) {
      tracker.firstToolCallAt = now;
      return;
    }
    if (now < tracker.firstToolCallAt) {
      tracker.firstToolCallAt = now;
    }
  }

  function noteReconnectObserved(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    tracker.lastReconnectAt = Date.now();
  }

  function updateLifecycleItemState(tracker, item, state) {
    if (!tracker || !item || typeof item !== "object" || typeof state !== "string") {
      return;
    }
    if (!tracker.activeLifecycleItemKeys) {
      tracker.activeLifecycleItemKeys = new Set();
    }
    if (!tracker.completedLifecycleItemKeys) {
      tracker.completedLifecycleItemKeys = new Set();
    }
    const key = makeLifecycleItemKey(item);
    if (!key) {
      return;
    }
    if (state === "completed") {
      tracker.completedLifecycleItemKeys.add(key);
      tracker.activeLifecycleItemKeys.delete(key);
      return;
    }
    if (state === "started") {
      if (tracker.completedLifecycleItemKeys.has(key)) {
        return;
      }
      tracker.activeLifecycleItemKeys.add(key);
    }
  }

  function makeLifecycleItemKey(item) {
    if (!item || typeof item !== "object") {
      return "";
    }
    const type = typeof item.type === "string" ? item.type : "unknown";
    const id = item.id !== undefined && item.id !== null ? String(item.id) : "";
    if (id) {
      return `${type}:${id}`;
    }
    return "";
  }

  function clearTurnFinalizeTimer(tracker) {
    if (!tracker?.turnFinalizeTimer) {
      return;
    }
    clearTimeout(tracker.turnFinalizeTimer);
    tracker.turnFinalizeTimer = null;
  }

  function scheduleTurnFinalizeWhenSettled(threadId, tracker) {
    if (!tracker || tracker.finalizing || tracker.completed) {
      return;
    }
    clearTurnFinalizeTimer(tracker);
    tracker.turnFinalizeTimer = setTimeout(() => {
      void maybeFinalizeTurnWhenSettled(threadId).catch((error) => {
        console.error(`turn settlement check failed for ${threadId}: ${formatErrorMessage(error)}`);
      });
    }, turnCompletionQuietMs);
    if (typeof tracker.turnFinalizeTimer?.unref === "function") {
      tracker.turnFinalizeTimer.unref();
    }
  }

  async function maybeFinalizeTurnWhenSettled(threadId) {
    const tracker = activeTurns.get(threadId);
    if (!tracker || tracker.finalizing || tracker.completed) {
      return;
    }
    const now = Date.now();
    const lastActivityAt = Number.isFinite(tracker.lastTurnActivityAt) ? tracker.lastTurnActivityAt : now;
    const quietForMs = now - lastActivityAt;
    const activeItemCount = tracker.activeLifecycleItemKeys?.size ?? 0;
    const requestedAt = Number.isFinite(tracker.turnCompletionRequestedAt) ? tracker.turnCompletionRequestedAt : now;
    const waitedMs = now - requestedAt;
    const lastReconnectAt = Number.isFinite(tracker.lastReconnectAt) ? tracker.lastReconnectAt : 0;
    const reconnectQuietForMs = lastReconnectAt > 0 ? now - lastReconnectAt : Infinity;
    const reconnectSettled = reconnectQuietForMs >= reconnectSettleQuietMs;

    if ((quietForMs < turnCompletionQuietMs || activeItemCount > 0 || !reconnectSettled) && waitedMs < turnCompletionMaxWaitMs) {
      debugLog("turn", "turn completion deferred until stream settles", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        quietForMs,
        activeItemCount,
        reconnectQuietForMs: Number.isFinite(reconnectQuietForMs) ? reconnectQuietForMs : null,
        reconnectSettled,
        waitedMs,
        quietWindowMs: turnCompletionQuietMs,
        reconnectQuietWindowMs: reconnectSettleQuietMs,
        maxWaitMs: turnCompletionMaxWaitMs
      });
      scheduleTurnFinalizeWhenSettled(threadId, tracker);
      return;
    }

    await finalizeTurn(threadId, null);
  }

  function markTurnReconnecting(tracker, line) {
    if (!tracker) {
      return;
    }
    transitionTurnPhase(tracker, TURN_PHASE.RECONNECTING);
    pushStatusLine(tracker, line);
    scheduleFlush(tracker);
  }

  async function ensureThinkingStage(tracker) {
    if (!tracker?.channel || !tracker?.statusMessageId || tracker?.hasToolCall) {
      clearThinkingTicker(tracker);
      return;
    }
    if (!tracker.thinkingStartedAt) {
      tracker.thinkingStartedAt = Date.now();
    }
    if (tracker.thinkingTicker) {
      return;
    }
    const tick = async () => {
      if (!tracker?.channel || !tracker?.statusMessageId || tracker?.hasToolCall) {
        clearThinkingTicker(tracker);
        return;
      }
      const startedAt = tracker.thinkingStartedAt || Date.now();
      const elapsed = formatDuration(Date.now() - startedAt);
      const payload = `⏳ Thinking... (${elapsed})`;
      pushStatusLine(tracker, payload);
      await editTrackerMessage(tracker, buildTrackerMessageContent(tracker));
    };
    void tick().catch((error) => {
      console.error(`thinking ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
    });
    tracker.thinkingTicker = setInterval(() => {
      void tick().catch((error) => {
        console.error(`thinking ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, 3000);
    if (typeof tracker.thinkingTicker?.unref === "function") {
      tracker.thinkingTicker.unref();
    }
  }

  async function ensureWorkingStage(tracker) {
    if (!tracker?.channel || tracker?.workingMessageId) {
      return;
    }
    if (tracker.workingMessageCreatePromise) {
      await tracker.workingMessageCreatePromise;
      return;
    }
    tracker.hasToolCall = true;
    clearThinkingTicker(tracker);
    if (!tracker.firstToolCallAt) {
      tracker.firstToolCallAt = Date.now();
    }
    const createPromise = (async () => {
      const elapsed = formatDuration(Date.now() - tracker.firstToolCallAt);
      const message = await safeSendToChannel(tracker.channel, `👷 Working (${elapsed})`);
      if (!message) {
        return;
      }
      tracker.workingMessage = message;
      tracker.workingMessageId = message.id;
      startWorkingTicker(tracker);
    })();
    tracker.workingMessageCreatePromise = createPromise;
    try {
      await createPromise;
    } finally {
      tracker.workingMessageCreatePromise = null;
    }
  }

  function startWorkingTicker(tracker) {
    if (!tracker?.workingMessageId || !tracker?.channel) {
      return;
    }
    clearWorkingTicker(tracker);
    const tick = async () => {
      if (!tracker?.workingMessageId || !tracker?.channel) {
        return;
      }
      const firstToolAt = tracker.firstToolCallAt || Date.now();
      const elapsed = formatDuration(Date.now() - firstToolAt);
      const payload = `👷 Working (${elapsed})`;
      try {
        const edited = await tracker.channel.messages.edit(tracker.workingMessageId, payload);
        if (edited) {
          tracker.workingMessage = edited;
        }
        tracker.workingLastRefreshAt = Date.now();
        debugLog("status", "working ticker refreshed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          discordMessageId: tracker.statusMessageId ?? null,
          workingMessageId: tracker.workingMessageId ?? null,
          elapsed,
          payload
        });
      } catch (error) {
        debugLog("status", "working ticker update failed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          discordMessageId: tracker.statusMessageId ?? null,
          workingMessageId: tracker.workingMessageId ?? null,
          error: truncateStatusText(String(error?.message ?? error ?? "unknown"), 220)
        });
      }
    };

    void tick().catch((error) => {
      console.error(`working ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
    });
    tracker.workingTicker = setInterval(() => {
      void tick().catch((error) => {
        console.error(`working ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, 3000);
    if (typeof tracker.workingTicker?.unref === "function") {
      tracker.workingTicker.unref();
    }
  }

  async function finalizeUxFlowStages(tracker) {
    clearWorkingTicker(tracker);
    if (tracker.hasToolCall && tracker.firstToolCallAt) {
      tracker.lastToolCompletedAt = Date.now();
      const elapsed = formatDuration(tracker.lastToolCompletedAt - tracker.firstToolCallAt);
      await safeSendToChannel(tracker.channel, `✅ Work complete (${elapsed})`);
    }
  }

  function clearWorkingTicker(tracker) {
    if (!tracker?.workingTicker) {
      return;
    }
    clearInterval(tracker.workingTicker);
    tracker.workingTicker = null;
  }

  function clearThinkingTicker(tracker) {
    if (!tracker?.thinkingTicker) {
      return;
    }
    clearInterval(tracker.thinkingTicker);
    tracker.thinkingTicker = null;
  }

  function appendTrackerText(tracker, text, { fromDelta }) {
    if (!text) {
      return;
    }
    tracker.fullText += text;
    if (fromDelta) {
      tracker.seenDelta = true;
    }
  }

  function pushStatusLine(tracker, line) {
    if (!tracker || typeof line !== "string") {
      return;
    }
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    if (tracker.currentStatusLine === normalized) {
      return;
    }
    tracker.currentStatusLine = normalized;
  }

  function buildTrackerMessageContent(tracker) {
    return truncateForDiscordMessage(tracker.currentStatusLine || "⏳ Thinking...", discordMaxMessageLength);
  }

  function summarizeForDebug(text, max = 180) {
    if (typeof text !== "string" || !text) {
      return "";
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 3))}...`;
  }

  async function editTrackerMessage(tracker, content) {
    if (!tracker?.channel || !content) {
      return;
    }
    if (tracker.lastRenderedContent === content) {
      return;
    }
    const payload = truncateForDiscordMessage(content, discordMaxMessageLength);
    try {
      if (tracker.statusMessage) {
        await tracker.statusMessage.edit(payload);
        tracker.lastRenderedContent = payload;
        debugLog("render", "edited status message", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId
        });
        return;
      }
    } catch (error) {
      debugLog("render", "direct edit failed", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        messageId: tracker.statusMessageId,
        error: String(error?.message ?? error)
      });
    }

    if (tracker.statusMessageId && tracker.channel?.isTextBased?.()) {
      try {
        const fetched = await tracker.channel.messages.fetch(tracker.statusMessageId);
        if (fetched) {
          await fetched.edit(payload);
          tracker.statusMessage = fetched;
          tracker.lastRenderedContent = payload;
          debugLog("render", "fetched and edited status message", {
            threadId: tracker.threadId,
            turnId: tracker.threadId,
            messageId: tracker.statusMessageId
          });
          return;
        }
      } catch (error) {
        debugLog("render", "fetch/edit fallback failed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId,
          error: String(error?.message ?? error)
        });
      }
    }

    const replacement = await safeSendToChannel(tracker.channel, payload);
    if (replacement) {
      const previousDiscordMessageId = tracker.statusMessageId ?? null;
      tracker.statusMessage = replacement;
      tracker.statusMessageId = replacement.id;
      tracker.lastRenderedContent = payload;
      debugLog("render", "sent replacement status message", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        previousDiscordMessageId,
        messageId: replacement.id
      });
    }
  }

  function isToolCallItemType(itemType) {
    return (
      itemType === "toolCall" ||
      itemType === "mcpToolCall" ||
      itemType === "commandExecution" ||
      itemType === "webSearch"
    );
  }

  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  return {
    handleNotification,
    finalizeTurn,
    onTurnReconnectPending
  };
}

function settleTracker(tracker, action, value) {
  if (!tracker || tracker.promiseSettled) {
    return;
  }
  tracker.promiseSettled = true;
  const settle = action === "reject" ? tracker.reject : tracker.resolve;
  if (typeof settle !== "function") {
    return;
  }
  try {
    settle(value);
  } catch (error) {
    console.error(`turn ${action} callback failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
  }
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(formatErrorMessage(error));
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}
