import path from "node:path";

export function summarizeItemForStatus(item, state) {
  if (!item || typeof item !== "object") {
    return [];
  }
  if (item.type === "commandExecution") {
    const command = truncateStatusText(typeof item.command === "string" ? item.command : "", 140);
    if (!command) {
      return [];
    }
    if (state === "started") {
      return [`⚙️ Command: \`${command}\``];
    }
    return [];
  }
  if (item.type === "webSearch") {
    const queries = extractWebSearchDetails(item);
    if (queries.length === 0) {
      return [];
    }
    if (state !== "started") {
      return [];
    }
    const normalized = normalizeSearchLabel(queries[0]);
    return [`🌍 Search: \`${truncateStatusText(normalized, 140)}\``];
  }
  if (item.type === "fileChange" && state === "completed") {
    const changes = Array.isArray(item.changes) ? item.changes : [item];
    const lines = [];
    for (const change of changes) {
      const entry = extractFileChangeEntry(change);
      if (!entry) {
        continue;
      }
      lines.push(`File edit: ${path.basename(entry.pathName)} +${entry.added} -${entry.removed}`);
      if (lines.length >= 4) {
        break;
      }
    }
    return lines;
  }
  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "server";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    if (state !== "started") {
      return [];
    }
    return [`🛠️ Tool: \`${truncateStatusText(`${server}/${tool}`, 140)}\``];
  }
  if (item.type === "imageView") {
    if (state !== "started") {
      return [];
    }
    const fileName = typeof item.path === "string" && item.path ? path.basename(item.path) : "image";
    return [`🖼️ Image: ${truncateStatusText(fileName, 140)}`];
  }
  if (item.type === "contextCompaction" && state === "completed") {
    return ["🧠 Context compacted"];
  }
  return [];
}

export function buildFileDiffSection(tracker) {
  if (!tracker?.fileChangeSummary || tracker.fileChangeSummary.size === 0) {
    return "";
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  const lines = [];
  for (const [pathName, stats] of tracker.fileChangeSummary.entries()) {
    const added = coerceNonNegativeInt(stats?.added);
    const removed = coerceNonNegativeInt(stats?.removed);
    totalAdded += added;
    totalRemoved += removed;
    const fileName = path.basename(pathName);
    lines.push({ fileName, added, removed });
  }
  lines.sort((a, b) => `${a.fileName}`.localeCompare(`${b.fileName}`));
  const maxLines = 10;
  const visible = lines.slice(0, maxLines);
  const green = "\u001b[32m";
  const red = "\u001b[31m";
  const dim = "\u001b[37m";
  const reset = "\u001b[0m";
  const parts = ["```ansi"];
  parts.push(`${green}📄${reset} ${dim}Files changed:${reset} ${green}+${totalAdded}${reset} ${red}-${totalRemoved}${reset}`);
  for (const { fileName, added, removed } of visible) {
    parts.push(`${dim}${fileName}${reset} ${green}+${added}${reset} ${red}-${removed}${reset}`);
  }
  if (lines.length > maxLines) {
    parts.push(`${dim}... ${lines.length - maxLines} more${reset}`);
  }
  parts.push("```");
  return parts.join("\n");
}

export function statusLabelForItemType(itemType) {
  const map = {
    commandExecution: "command",
    mcpToolCall: "tool call",
    webSearch: "web search",
    fileChange: "file change",
    imageView: "image view",
    contextCompaction: "context compaction",
    collabAgentToolCall: "collab tool",
    toolCall: "tool",
    review: "review"
  };
  return map[itemType] ?? itemType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function recordFileChanges(tracker, item) {
  if (!tracker || !item || typeof item !== "object") {
    return;
  }
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    const entry = extractFileChangeEntry(item);
    if (entry) {
      const existing = tracker.fileChangeSummary.get(entry.pathName) ?? { added: 0, removed: 0 };
      existing.added += entry.added;
      existing.removed += entry.removed;
      tracker.fileChangeSummary.set(entry.pathName, existing);
    }
    return;
  }
  for (const change of changes) {
    const entry = extractFileChangeEntry(change);
    if (!entry) {
      continue;
    }
    const existing = tracker.fileChangeSummary.get(entry.pathName) ?? { added: 0, removed: 0 };
    existing.added += entry.added;
    existing.removed += entry.removed;
    tracker.fileChangeSummary.set(entry.pathName, existing);
  }
}

export function extractWebSearchDetails(item) {
  const details = [];
  const add = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    details.push(trimmed);
  };

  add(item?.query);
  const action = item?.action;
  if (action?.type === "search") {
    add(action.query);
    if (Array.isArray(action.queries)) {
      for (const query of action.queries) {
        add(query);
      }
    }
  } else if (action?.type === "openPage") {
    add(action.url);
  } else if (action?.type === "findInPage") {
    add(action.pattern);
    add(action.url);
  }

  return [...new Set(details)];
}

export function truncateStatusText(text, limit) {
  if (typeof text !== "string") {
    return "";
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(1, limit - 3))}...`;
}

function normalizeSearchLabel(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname) {
      return url.hostname;
    }
  } catch {}
  return trimmed;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

function coerceNonNegativeInt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }
  return 0;
}

function extractFileChangeEntry(change) {
  if (!change || typeof change !== "object") {
    return null;
  }
  const pathName = pickFirstString(change.path, change.file, change.filename, change.name);
  if (!pathName) {
    return null;
  }
  const added = coerceNonNegativeInt(
    change.added,
    change.additions,
    change.insertions,
    change.linesAdded,
    change.lines_added,
    change.addedLines
  );
  const removed = coerceNonNegativeInt(
    change.removed,
    change.deletions,
    change.linesRemoved,
    change.lines_removed,
    change.deletedLines
  );
  let resolvedAdded = added;
  let resolvedRemoved = removed;
  if (resolvedAdded === 0 && resolvedRemoved === 0 && typeof change.diff === "string") {
    const counted = countDiffLines(change.diff);
    resolvedAdded = counted.added;
    resolvedRemoved = counted.removed;
  }
  return { pathName, added: resolvedAdded, removed: resolvedRemoved };
}

function countDiffLines(diffText) {
  if (typeof diffText !== "string" || !diffText.trim()) {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}
