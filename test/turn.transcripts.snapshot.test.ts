import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAttachmentCandidates } from "../src/attachments/service.js";
import { buildResponseForServerRequest, parseApprovalButtonCustomId } from "../src/codex/approvalPayloads.js";
import { normalizeCodexNotification } from "../src/codex/notificationMapper.js";
import { buildTurnRenderPlan } from "../src/render/messageRenderer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_PATH = path.join(__dirname, "snapshots", "turn-transcripts.snapshot.json");

describe("turn transcript snapshots", () => {
  test("matches representative happy/failure/approval/file-send transcripts", () => {
    const actual = buildRepresentativeTranscripts();
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(actual).toEqual(expected);
  });
});

function buildRepresentativeTranscripts() {
  return {
    happyPath: {
      notifications: [
        normalizeCodexNotification({
          method: "item/started",
          params: { threadId: "thread-1", item: { id: "item-1", type: "agentMessage" } }
        }),
        normalizeCodexNotification({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", delta: "Applied fix and generated summary." }
        }),
        normalizeCodexNotification({
          method: "item/completed",
          params: { threadId: "thread-1", item: { id: "item-1", type: "agentMessage" } }
        }),
        normalizeCodexNotification({
          method: "turn/completed",
          params: { threadId: "thread-1" }
        })
      ],
      renderPlanUser: buildTurnRenderPlan({
        summaryText: "Done. Preview ![img](/tmp/build/final.png) and logs at /tmp/build/run.log",
        diffBlock: "```diff\n+ one line changed\n```",
        verbosity: "user"
      }),
      renderPlanOps: buildTurnRenderPlan({
        summaryText: "Done. Preview ![img](/tmp/build/final.png) and logs at /tmp/build/run.log",
        diffBlock: "```diff\n+ one line changed\n```",
        verbosity: "ops"
      })
    },
    failurePath: {
      notification: normalizeCodexNotification({
        method: "error",
        params: { threadId: "thread-2", error: { message: "Sandbox denied write access." } }
      }),
      renderPlan: buildTurnRenderPlan({
        summaryText: "Failed while updating /Users/dev/work/repo/src/index.ts",
        diffBlock: "stderr: Permission denied",
        verbosity: "ops"
      })
    },
    approvalPath: {
      parsedButton: parseApprovalButtonCustomId("approval:0042:accept", "approval:"),
      applyPatchAccept: buildResponseForServerRequest("applyPatchApproval", {}, "accept"),
      execDecline: buildResponseForServerRequest("execCommandApproval", {}, "decline"),
      userInputAccept: buildResponseForServerRequest(
        "item/tool/requestUserInput",
        {
          questions: [
            {
              id: "confirm",
              options: [{ label: "Continue" }, { label: "Cancel" }]
            }
          ]
        },
        "accept"
      )
    },
    fileSendPath: {
      explicitImageView: extractAttachmentCandidates(
        {
          type: "imageView",
          path: "/tmp/screens/latest.png"
        },
        { attachmentInferFromText: false }
      ),
      inferredLastMatch: extractAttachmentCandidates(
        {
          type: "commandExecution",
          text: "generated /tmp/screens/one.png then /tmp/screens/two.png"
        },
        { attachmentInferFromText: true }
      )
    }
  };
}
