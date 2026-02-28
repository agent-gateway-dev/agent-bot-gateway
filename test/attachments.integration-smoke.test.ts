import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maybeSendAttachmentsForItem } from "../src/attachments/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("attachments integration smoke", () => {
  test("uploads one outbound image for an explicit imageView item", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const imagePath = path.join(realTmpDir, "capture-latest.png");
    await fs.writeFile(imagePath, "fake-image-bytes");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const issueMessages: string[] = [];
    const tracker = {
      channel: { id: "channel-1" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      { type: "imageView", id: "item-1", path: imagePath },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["imageView"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: false,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async (_channel: unknown, text: string) => {
          issueMessages.push(text);
          return null;
        },
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(issueMessages).toEqual([]);
    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("capture-latest.png");
    expect(Array.isArray(sentPayloads[0]?.files)).toBe(true);
  });

  test("inferred text fallback uploads only the last referenced media path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const one = path.join(realTmpDir, "one.png");
    const two = path.join(realTmpDir, "two.png");
    await fs.writeFile(one, "one");
    await fs.writeFile(two, "two");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-2" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      {
        type: "commandExecution",
        id: "item-2",
        text: `generated ${one} and then finalized ${two}`
      },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["commandExecution"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: true,
        statusLabelForItemType: () => "command",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("two.png");
    expect(String(sentPayloads[0]?.content ?? "")).not.toContain("one.png");
  });

  test("suppresses attachment issue notices when max issue messages is zero", async () => {
    const issueMessages: string[] = [];
    const tracker = {
      channel: { id: "channel-3" },
      cwd: "/tmp",
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      { type: "imageView", id: "item-3", path: "https://example.com/image.png" },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["imageView"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: ["/tmp"],
        imageCacheDir: "/tmp",
        attachmentInferFromText: false,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async (_channel: unknown, text: string) => {
          issueMessages.push(text);
          return null;
        },
        safeSendToChannelPayload: async () => null,
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 0
      }
    );

    expect(issueMessages).toEqual([]);
  });
});
