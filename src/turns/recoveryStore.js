import { isMissingRolloutPathError } from "../app/runtimeUtils.js";

export function createTurnRecoveryStore(deps) {
  const { fs, path, recoveryPath, debugLog } = deps;
  const store = {
    schemaVersion: 2,
    turns: {},
    requests: {}
  };
  const requestTtlMs = Number.isFinite(Number(process.env.TURN_REQUEST_STATUS_TTL_MS))
    ? Math.max(60_000, Math.floor(Number(process.env.TURN_REQUEST_STATUS_TTL_MS)))
    : 7 * 24 * 60 * 60 * 1000;
  const maxRequests = Number.isFinite(Number(process.env.TURN_REQUEST_STATUS_MAX_RECORDS))
    ? Math.max(100, Math.floor(Number(process.env.TURN_REQUEST_STATUS_MAX_RECORDS)))
    : 5000;
  let saveQueue = Promise.resolve();

  async function load() {
    await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
    try {
      const raw = await fs.readFile(recoveryPath, "utf8");
      const parsed = JSON.parse(raw);
      store.schemaVersion = 2;
      store.turns =
        parsed && typeof parsed.turns === "object" && parsed.turns !== null ? { ...parsed.turns } : {};
      store.requests =
        parsed && typeof parsed.requests === "object" && parsed.requests !== null ? { ...parsed.requests } : {};
      pruneRequestStatuses();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await save();
    }
  }

  async function save() {
    const writeOnce = async () => {
      pruneRequestStatuses();
      await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
      const tempPath = `${recoveryPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
      await fs.rename(tempPath, recoveryPath);
    };

    const writeWithRetry = async () => {
      try {
        await writeOnce();
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        await writeOnce();
      }
    };

    const nextSave = saveQueue.then(writeWithRetry, writeWithRetry);
    saveQueue = nextSave.catch(() => {});
    await nextSave;
  }

  async function upsertTurnFromTracker(tracker) {
    if (!tracker?.threadId || !tracker?.repoChannelId) {
      return;
    }
    store.turns[tracker.threadId] = {
      threadId: tracker.threadId,
      repoChannelId: tracker.repoChannelId,
      platform: tracker.platform ?? null,
      requestId: tracker.requestId ?? null,
      sourceMessageId: tracker.sourceMessageId ?? null,
      channelId: tracker.channel?.id ?? tracker.repoChannelId,
      statusMessageId: tracker.statusMessageId ?? null,
      cwd: tracker.cwd ?? null,
      lifecyclePhase: tracker.lifecyclePhase ?? null,
      seenDelta: tracker.seenDelta === true,
      fullTextLength: typeof tracker.fullText === "string" ? tracker.fullText.length : 0,
      updatedAt: new Date().toISOString()
    };
    upsertRequestStatus({
      platform: tracker.platform,
      requestId: tracker.requestId,
      threadId: tracker.threadId,
      repoChannelId: tracker.repoChannelId,
      channelId: tracker.channel?.id ?? tracker.repoChannelId,
      sourceMessageId: tracker.sourceMessageId ?? null,
      status: "processing"
    });
    await save();
  }

  async function removeTurn(threadId, options = {}) {
    if (!threadId || !store.turns[threadId]) {
      return;
    }
    const snapshot = store.turns[threadId];
    const requestStatus = typeof options.status === "string" && options.status ? options.status : "unknown";
    upsertRequestStatus({
      platform: snapshot.platform,
      requestId: snapshot.requestId,
      threadId: snapshot.threadId,
      repoChannelId: snapshot.repoChannelId,
      channelId: snapshot.channelId,
      sourceMessageId: snapshot.sourceMessageId,
      status: requestStatus,
      errorMessage: options.errorMessage ?? null
    });
    delete store.turns[threadId];
    await save();
  }

  function getRequestStatus(requestId) {
    if (!requestId) {
      return null;
    }
    const entry = store.requests[String(requestId)];
    if (!entry) {
      return null;
    }
    return structuredClone(entry);
  }

  function findRequestStatusBySource({ sourceMessageId, routeId, platform } = {}) {
    const messageId = String(sourceMessageId ?? "").trim();
    if (!messageId) {
      return null;
    }
    const normalizedRouteId = String(routeId ?? "").trim();
    const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
    const candidates = Object.values(store.requests).filter((entry) => {
      if (String(entry?.sourceMessageId ?? "").trim() !== messageId) {
        return false;
      }
      if (normalizedRouteId) {
        const entryRoute = String(entry?.repoChannelId ?? entry?.channelId ?? "").trim();
        if (entryRoute && entryRoute !== normalizedRouteId) {
          return false;
        }
      }
      if (normalizedPlatform) {
        const entryPlatform = String(entry?.platform ?? "").trim().toLowerCase();
        if (entryPlatform && entryPlatform !== normalizedPlatform) {
          return false;
        }
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftAt = new Date(left?.updatedAt ?? left?.createdAt ?? 0).getTime();
      const rightAt = new Date(right?.updatedAt ?? right?.createdAt ?? 0).getTime();
      return rightAt - leftAt;
    });
    return structuredClone(candidates[0]);
  }

  function snapshot() {
    return structuredClone(store);
  }

  async function reconcilePending(options) {
    const { fetchChannelByRouteId, codex, safeSendToChannel } = options;
    const turns = Object.values(store.turns);
    if (turns.length === 0) {
      return { reconciled: 0, resumedKnown: 0, missingThread: 0, skipped: 0 };
    }

    const knownThreads = await fetchKnownThreadIds(codex);
    let resumedKnown = 0;
    let missingThread = 0;
    let skipped = 0;

    for (const turn of turns) {
      const channel = await fetchChannelByRouteId(turn.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        skipped += 1;
        await removeTurn(turn.threadId);
        continue;
      }

      const threadKnown = knownThreads.status === "available" ? knownThreads.ids.has(turn.threadId) : null;
      const settlementText =
        threadKnown === true
          ? "🔄 Recovered after restart. Previous in-flight turn may still settle. If no follow-up appears, retry your last message."
          : threadKnown === false
            ? "⚠️ Recovered after restart. Previous in-flight turn could not be resumed safely. Please retry."
            : "⚠️ Recovered after restart. Previous in-flight turn status could not be verified safely. Please retry if no follow-up appears.";
      const settlementWithRequestId = turn.requestId
        ? `${settlementText}\nrequest_id: \`${turn.requestId}\``
        : settlementText;

      if (threadKnown === true) {
        resumedKnown += 1;
      } else if (threadKnown === false) {
        missingThread += 1;
      }

      let edited = false;
      if (turn.statusMessageId) {
        try {
          const message = await channel.messages.fetch(turn.statusMessageId);
          if (message) {
            await message.edit(settlementWithRequestId);
            edited = true;
          }
        } catch {}
      }
      if (!edited) {
        await safeSendToChannel(channel, settlementWithRequestId);
      }

      await removeTurn(turn.threadId, {
        status: threadKnown === true ? "recovery_pending" : threadKnown === false ? "recovery_unavailable" : "unknown"
      });
    }

    return {
      reconciled: turns.length,
      resumedKnown,
      missingThread,
      skipped
    };
  }

  async function fetchKnownThreadIds(codex) {
    const ids = new Set();
    let cursor = undefined;
    for (let page = 0; page < 20; page += 1) {
      try {
        const params = { limit: 100, sortKey: "updated_at" };
        if (cursor) {
          params.cursor = cursor;
        }
        const response = await codex.request("thread/list", params);
        const rows = Array.isArray(response?.data) ? response.data : [];
        for (const row of rows) {
          if (typeof row?.id === "string" && row.id) {
            ids.add(row.id);
          }
        }
        if (!response?.nextCursor) {
          break;
        }
        cursor = response.nextCursor;
      } catch (error) {
        const errorMessage = String(error?.message ?? error);
        if (isMissingRolloutPathError(errorMessage)) {
          debugLog?.("recovery", "thread list failed due to missing rollout path, continuing", {
            message: errorMessage
          });
          return { ids, status: "unknown" };
        }
        debugLog?.("recovery", "thread list failed while reconciling", {
          message: errorMessage
        });
        return { ids, status: "unknown" };
      }
    }
    return { ids, status: "available" };
  }

  function upsertRequestStatus(entry) {
    const requestId = typeof entry?.requestId === "string" ? entry.requestId : "";
    if (!requestId) {
      return;
    }
    const existing = store.requests[requestId] ?? {};
    const nextStatus = typeof entry.status === "string" && entry.status ? entry.status : existing.status ?? "processing";
    store.requests[requestId] = {
      requestId,
      platform: entry.platform ?? existing.platform ?? null,
      threadId: entry.threadId ?? existing.threadId ?? null,
      repoChannelId: entry.repoChannelId ?? existing.repoChannelId ?? null,
      channelId: entry.channelId ?? existing.channelId ?? null,
      sourceMessageId: entry.sourceMessageId ?? existing.sourceMessageId ?? null,
      status: nextStatus,
      errorMessage:
        typeof entry.errorMessage === "string"
          ? entry.errorMessage
          : entry.errorMessage === null
            ? null
            : existing.errorMessage ?? null,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function pruneRequestStatuses() {
    const now = Date.now();
    const entries = Object.entries(store.requests);
    if (entries.length === 0) {
      return;
    }

    for (const [requestId, value] of entries) {
      const updatedAt = new Date(value?.updatedAt ?? value?.createdAt ?? 0).getTime();
      if (!Number.isFinite(updatedAt) || now - updatedAt > requestTtlMs) {
        delete store.requests[requestId];
      }
    }

    const remaining = Object.values(store.requests);
    if (remaining.length <= maxRequests) {
      return;
    }
    remaining.sort((left, right) => {
      const leftAt = new Date(left?.updatedAt ?? left?.createdAt ?? 0).getTime();
      const rightAt = new Date(right?.updatedAt ?? right?.createdAt ?? 0).getTime();
      return rightAt - leftAt;
    });
    const keep = new Set(remaining.slice(0, maxRequests).map((item) => item.requestId));
    for (const requestId of Object.keys(store.requests)) {
      if (!keep.has(requestId)) {
        delete store.requests[requestId];
      }
    }
  }

  return {
    load,
    snapshot,
    upsertTurnFromTracker,
    removeTurn,
    getRequestStatus,
    findRequestStatusBySource,
    reconcilePending
  };
}
