import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  parseApprovalButtonCustomId
} from "../src/codex/approvalPayloads.js";

describe("approval payloads", () => {
  test("maps exec/apply approval decisions to review decision format", () => {
    expect(buildResponseForServerRequest("execCommandApproval", {}, "accept")).toEqual({ decision: "approved" });
    expect(buildResponseForServerRequest("applyPatchApproval", {}, "decline")).toEqual({ decision: "denied" });
    expect(buildResponseForServerRequest("applyPatchApproval", {}, "cancel")).toEqual({ decision: "abort" });
  });

  test("builds tool request user input answers using matching option labels", () => {
    const response = buildResponseForServerRequest(
      "item/tool/requestUserInput",
      {
        questions: [
          {
            id: "confirm",
            options: [{ label: "Continue" }, { label: "Cancel" }]
          },
          {
            id: "mode",
            options: [{ label: "Decline" }, { label: "Approve" }]
          }
        ]
      },
      "accept"
    );

    expect(response).toEqual({
      answers: {
        confirm: { answers: ["Continue"] },
        mode: { answers: ["Approve"] }
      }
    });
  });

  test("parses approval button custom ids", () => {
    expect(parseApprovalButtonCustomId("approval:0007:accept", "approval:")).toEqual({
      token: "0007",
      decision: "accept"
    });
    expect(parseApprovalButtonCustomId("approval:0008:noop", "approval:")).toBeNull();
    expect(parseApprovalButtonCustomId("other:0008:accept", "approval:")).toBeNull();
  });

  test("builds raw discord component payloads without discord.js builders", () => {
    expect(buildApprovalActionRows("0007", "approval:")).toEqual([
      {
        type: 1,
        components: [
          { type: 2, custom_id: "approval:0007:accept", label: "Approve", style: 3, disabled: false },
          { type: 2, custom_id: "approval:0007:decline", label: "Decline", style: 4, disabled: false },
          { type: 2, custom_id: "approval:0007:cancel", label: "Cancel", style: 2, disabled: false }
        ]
      }
    ]);
  });

  test("can be imported in a runtime without discord.js installed", async () => {
    const fixtureRoot = path.join(os.tmpdir(), `approval-payloads-${randomUUID()}`);
    const fixtureModulePath = path.join(fixtureRoot, "src", "codex", "approvalPayloads.js");
    const sourceModulePath = path.resolve(process.cwd(), "src/codex/approvalPayloads.js");

    await fs.mkdir(path.dirname(fixtureModulePath), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{\n  "type": "module"\n}\n', "utf8");
    await fs.copyFile(sourceModulePath, fixtureModulePath);

    try {
      const imported = await import(pathToFileURL(fixtureModulePath).href);
      expect(imported.buildApprovalActionRows("0008", "approval:")).toEqual([
        {
          type: 1,
          components: [
            { type: 2, custom_id: "approval:0008:accept", label: "Approve", style: 3, disabled: false },
            { type: 2, custom_id: "approval:0008:decline", label: "Decline", style: 4, disabled: false },
            { type: 2, custom_id: "approval:0008:cancel", label: "Cancel", style: 2, disabled: false }
          ]
        }
      ]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
