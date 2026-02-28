export function normalizeCodexNotification(event) {
  const method = typeof event?.method === "string" ? event.method : "";
  const params = event?.params;
  const threadId = extractThreadId(params);

  if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return {
      kind: "agent_delta",
      method,
      threadId,
      delta
    };
  }

  if (method === "item/started" || method === "item/completed") {
    return {
      kind: "item_lifecycle",
      method,
      threadId,
      state: method === "item/started" ? "started" : "completed",
      item: params?.item
    };
  }

  if (method === "turn/completed" || method === "codex/event/task_complete") {
    return {
      kind: "turn_completed",
      method,
      threadId
    };
  }

  if (method === "error") {
    const errorMessage = params?.error?.message || params?.message || "Codex reported an error";
    return {
      kind: "error",
      method,
      threadId,
      errorMessage
    };
  }

  return {
    kind: "unknown",
    method,
    threadId
  };
}

function extractThreadId(params) {
  if (typeof params?.threadId === "string") {
    return params.threadId;
  }
  if (typeof params?.conversationId === "string") {
    return params.conversationId;
  }
  if (typeof params?.item?.threadId === "string") {
    return params.item.threadId;
  }
  if (typeof params?.turn?.threadId === "string") {
    return params.turn.threadId;
  }
  return null;
}
