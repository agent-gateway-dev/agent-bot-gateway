export function formatInputTextForSetup(text, setup) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (setup?.mode !== "general") {
    return trimmed;
  }
  return [
    "[Channel context: #general]",
    "Treat this channel as informational Q&A and general conversation.",
    "Do not assume repo work, file edits, or tool/command execution unless explicitly requested.",
    "Ignore local cwd/repo context unless the user explicitly asks for it.",
    "",
    trimmed
  ].join("\n");
}

export function waitForDiscordReady(client) {
  if (client.isReady()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    client.once("clientReady", () => resolve());
  });
}

export function isDiscordMissingPermissionsError(error) {
  return (
    Number(error?.code) === 50013 ||
    Number(error?.rawError?.code) === 50013 ||
    String(error?.message ?? "").toLowerCase().includes("missing permissions")
  );
}

export function createDebugLog(debugLoggingEnabled) {
  return function debugLog(scope, message, details) {
    if (!debugLoggingEnabled) {
      return;
    }
    if (details === undefined) {
      console.log(`[debug:${scope}] ${message}`);
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(details);
    } catch {
      serialized = String(details);
    }
    const trimmed = serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized;
    console.log(`[debug:${scope}] ${message} ${trimmed}`);
  };
}

export function isBenignCodexStderrLine(line) {
  const normalized = stripAnsi(String(line ?? "")).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("codex_core::rollout::recorder") && normalized.includes("falling back on rollout system")
  ) || (
    normalized.includes("codex_core::state_db") &&
    normalized.includes("list_threads_with_db_fallback") &&
    normalized.includes("falling_back")
  );
}

export function isMissingRolloutPathError(line) {
  // codex stderr 可能带 ANSI 颜色码，先归一化再匹配，避免误判漏报。
  const normalized = stripAnsi(String(line ?? "")).toLowerCase();
  return normalized.includes("state db missing rollout path for thread");
}

function stripAnsi(text) {
  const input = String(text ?? "");
  let output = "";
  let index = 0;
  while (index < input.length) {
    if (input.charCodeAt(index) !== 27) {
      output += input[index];
      index += 1;
      continue;
    }

    index += 1;
    if (input[index] === "[") {
      index += 1;
      while (index < input.length && input[index] !== "m") {
        index += 1;
      }
      if (input[index] === "m") {
        index += 1;
      }
      continue;
    }
  }
  return output;
}
