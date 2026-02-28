import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function maybeSendAttachmentsForItem(tracker, item, context) {
  const {
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText
  } = context;

  if (!attachmentsEnabled || !tracker?.channel || !item || typeof item !== "object") {
    return;
  }
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemType || !attachmentItemTypes.has(itemType)) {
    return;
  }

  const paths = extractAttachmentPaths(item);
  if (paths.length === 0) {
    return;
  }
  const declaredPaths = new Set(extractDeclaredAttachmentPaths(item).map((value) => value.trim()));

  for (const filePath of paths) {
    const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
    const announceFailures = itemType === "imageView" || declaredPaths.has(normalizedPath);
    await sendAttachmentForPath(tracker, filePath, { itemType, itemId: item.id, announceFailures }, {
      attachmentMaxBytes,
      attachmentRoots,
      imageCacheDir,
      statusLabelForItemType,
      safeSendToChannel,
      safeSendToChannelPayload,
      truncateStatusText
    });
  }
}

function extractDeclaredAttachmentPaths(item) {
  const declared = [];
  const add = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      declared.push(trimmed);
    }
  };

  add(item?.path);
  add(item?.file);
  add(item?.filename);
  add(item?.name);
  add(item?.outputPath);
  add(item?.artifactPath);
  if (Array.isArray(item?.paths)) {
    for (const value of item.paths) {
      add(value);
    }
  }
  if (Array.isArray(item?.files)) {
    for (const entry of item.files) {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        add(entry.path);
        add(entry.file);
        add(entry.name);
        add(entry.filename);
      }
    }
  }
  return [...new Set(declared)];
}

function extractAttachmentPaths(item) {
  const paths = [];
  const pathLikeKeys = new Set(["path", "file", "filename", "name", "outputPath", "artifactPath"]);
  const add = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      paths.push(trimmed);
    }
  };

  add(item.path);
  add(item.file);
  add(item.filename);
  add(item.name);
  add(item.outputPath);
  add(item.artifactPath);
  for (const candidate of collectLikelyLocalPathsFromText(item.text)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.output)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.aggregatedOutput)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.stdout)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.stderr)) {
    add(candidate);
  }

  if (Array.isArray(item.paths)) {
    for (const value of item.paths) {
      add(value);
    }
  }

  if (Array.isArray(item.files)) {
    for (const entry of item.files) {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        add(entry.path);
        add(entry.file);
        add(entry.name);
        add(entry.filename);
      }
    }
  }

  const queue = [{ value: item, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0 && paths.length < 64) {
    const current = queue.shift();
    if (!current || current.depth > 3) {
      continue;
    }
    const { value, depth } = current;
    if (!value || typeof value !== "object") {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        queue.push({ value: entry, depth: depth + 1 });
      }
      continue;
    }

    for (const [key, entry] of Object.entries(value)) {
      if (pathLikeKeys.has(key) && typeof entry === "string") {
        add(entry);
      }
      if (typeof entry === "string") {
        for (const candidate of collectLikelyLocalPathsFromText(entry)) {
          add(candidate);
        }
      }
      if (entry && typeof entry === "object") {
        queue.push({ value: entry, depth: depth + 1 });
      }
    }
  }

  return [...new Set(paths)];
}

function collectLikelyLocalPathsFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  const found = new Set();
  const mediaPathPattern =
    /(?:^|[\s([`'"])((?:\/|~\/)[^)\]`'"<>\r\n]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg))(?:$|[\s)\]`'",.!?:;])/gi;
  let match = mediaPathPattern.exec(text);
  while (match) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      found.add(candidate);
    }
    match = mediaPathPattern.exec(text);
  }

  const markdownLinkPathPattern = /\]\(((?:\/|~\/)[^)]+)\)/g;
  match = markdownLinkPathPattern.exec(text);
  while (match) {
    const raw = String(match[1] ?? "").trim();
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg)$/i.test(raw)) {
      found.add(raw);
    }
    match = markdownLinkPathPattern.exec(text);
  }

  return [...found];
}

async function sendAttachmentForPath(tracker, filePath, options = {}, context) {
  const { itemType, itemId, announceFailures = false } = options;
  const {
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText
  } = context;

  if (!tracker?.channel) {
    return;
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    return;
  }
  const trimmed = filePath.trim();
  if (!isSupportedMediaPath(trimmed)) {
    return;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    await maybeSendAttachmentIssue(
      tracker,
      `remote:${trimmed}`,
      `Attachment skipped (remote URL not supported): \`${truncateStatusText(trimmed, 120)}\``,
      announceFailures,
      safeSendToChannel
    );
    return;
  }

  const resolvedInputPath = path.isAbsolute(trimmed)
    ? trimmed
    : typeof tracker?.cwd === "string" && tracker.cwd
      ? path.resolve(tracker.cwd, trimmed)
      : path.resolve(trimmed);

  let realPath;
  try {
    realPath = await fs.realpath(resolvedInputPath);
  } catch {
    await maybeSendAttachmentIssue(
      tracker,
      `missing:${resolvedInputPath}`,
      `Attachment missing: \`${path.basename(trimmed)}\``,
      announceFailures,
      safeSendToChannel
    );
    return;
  }

  const allowedRoots = resolveAttachmentRoots(tracker, attachmentRoots, imageCacheDir);
  if (!isPathWithinRoots(realPath, allowedRoots)) {
    await maybeSendAttachmentIssue(
      tracker,
      `blocked:${realPath}`,
      `Attachment blocked (outside allowed roots): \`${path.basename(realPath)}\``,
      announceFailures,
      safeSendToChannel
    );
    return;
  }

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch {
    await maybeSendAttachmentIssue(
      tracker,
      `unreadable:${realPath}`,
      `Attachment unreadable: \`${path.basename(realPath)}\``,
      announceFailures,
      safeSendToChannel
    );
    return;
  }
  if (!stats.isFile()) {
    return;
  }

  if (stats.size > attachmentMaxBytes) {
    await maybeSendAttachmentIssue(
      tracker,
      `too-large:${realPath}:${stats.size}`,
      `Attachment too large (${formatBytes(stats.size)} > ${formatBytes(attachmentMaxBytes)}): \`${path.basename(realPath)}\``,
      announceFailures,
      safeSendToChannel
    );
    return;
  }

  const key = itemId ? `${itemId}:${realPath}` : realPath;
  if (tracker.sentAttachmentKeys?.has(key)) {
    return;
  }
  tracker.sentAttachmentKeys?.add(key);

  const label = itemType ? statusLabelForItemType(itemType) : "attachment";
  const content = `Attachment (${label}): \`${path.basename(realPath)}\``;
  await safeSendToChannelPayload(tracker.channel, {
    content,
    files: [{ attachment: realPath, name: path.basename(realPath) }]
  });
}

async function maybeSendAttachmentIssue(tracker, key, message, announce, safeSendToChannel) {
  if (!announce || !tracker?.channel) {
    return;
  }
  const normalizedKey = typeof key === "string" ? key : String(key);
  if (tracker.seenAttachmentIssueKeys?.has(normalizedKey)) {
    return;
  }
  tracker.seenAttachmentIssueKeys?.add(normalizedKey);
  await safeSendToChannel(tracker.channel, message);
}

function isSupportedMediaPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg)$/.test(
    normalized
  );
}

function resolveAttachmentRoots(tracker, attachmentRoots, imageCacheDir) {
  const roots = new Set();
  if (typeof tracker?.cwd === "string" && tracker.cwd) {
    roots.add(path.resolve(tracker.cwd));
  }
  if (imageCacheDir) {
    roots.add(path.resolve(imageCacheDir));
  }
  for (const root of attachmentRoots) {
    if (root) {
      roots.add(path.resolve(root));
    }
  }
  if (process.platform !== "win32") {
    roots.add(path.resolve("/tmp"));
  }
  return [...roots];
}

function isPathWithinRoots(targetPath, roots) {
  if (typeof targetPath !== "string" || !targetPath) {
    return false;
  }
  for (const root of roots) {
    if (typeof root !== "string" || !root) {
      continue;
    }
    const relative = path.relative(root, targetPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
