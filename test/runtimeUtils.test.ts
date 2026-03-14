import { beforeEach, describe, expect, test } from "bun:test";
import {
  createDebugLog,
  formatInputTextForSetup,
  isBenignCodexStderrLine,
  isDiscordMissingPermissionsError,
  isMissingRolloutPathError
} from "../src/app/runtimeUtils.js";

describe("runtime utils", () => {
  test("formatInputTextForSetup leaves repo content unchanged", () => {
    const text = "  hello world  ";
    expect(formatInputTextForSetup(text, { mode: "repo" })).toBe("hello world");
  });

  test("formatInputTextForSetup prepends general-channel guidance", () => {
    const formatted = formatInputTextForSetup("hello", { mode: "general" });
    expect(formatted).toContain("[Channel context: #general]");
    expect(formatted).toContain("hello");
  });

  test("isDiscordMissingPermissionsError detects code and message variants", () => {
    expect(isDiscordMissingPermissionsError({ code: 50013 })).toBe(true);
    expect(isDiscordMissingPermissionsError({ rawError: { code: 50013 } })).toBe(true);
    expect(isDiscordMissingPermissionsError({ message: "Missing permissions for this action" })).toBe(true);
    expect(isDiscordMissingPermissionsError({ code: 40001 })).toBe(false);
  });

  test("isBenignCodexStderrLine filters known fallback noise", () => {
    expect(
      isBenignCodexStderrLine(
        "\u001b[2m2026-03-13T04:50:24.506299Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::recorder\u001b[0m: Falling back on rollout system"
      )
    ).toBe(true);
    expect(
      isBenignCodexStderrLine(
        "2026-03-13T04:36:40Z WARN codex_core::state_db: state db record_discrepancy: list_threads_with_db_fallback, falling_back"
      )
    ).toBe(true);
    expect(isBenignCodexStderrLine("ERROR some_other_component: real failure")).toBe(false);
  });

  test("isMissingRolloutPathError detects rollout path errors", () => {
    expect(
      isMissingRolloutPathError("state db missing rollout path for thread 019ce72a-144e-79c2-9dc8-a08720e5661c")
    ).toBe(true);
    expect(
      isMissingRolloutPathError("State db missing rollout path for thread some-thread-id")
    ).toBe(true);
    expect(
      isMissingRolloutPathError("state db missing rollout path FOR thread abcdef")
    ).toBe(true);
    expect(
      isMissingRolloutPathError(
        "\u001b[2m2026-03-13T04:50:24.506299Z\u001b[0m \u001b[31mERROR\u001b[0m state db missing rollout path for thread ansi-thread"
      )
    ).toBe(true);
    expect(
      isMissingRolloutPathError("some other error not about rollout path")
    ).toBe(false);
    expect(isMissingRolloutPathError("")).toBe(false);
  });

  describe("createDebugLog", () => {
    let originalConsoleLog: typeof console.log;

    beforeEach(() => {
      originalConsoleLog = console.log;
    });

    test("suppresses logs when debug mode is disabled", () => {
      const lines = [];
      console.log = (...args) => {
        lines.push(args.join(" "));
      };
      const debugLog = createDebugLog(false);
      debugLog("scope", "message", { key: "value" });
      expect(lines).toHaveLength(0);
      console.log = originalConsoleLog;
    });

    test("logs compact JSON details when enabled", () => {
      const lines = [];
      console.log = (...args) => {
        lines.push(args.join(" "));
      };
      const debugLog = createDebugLog(true);
      debugLog("scope", "message", { key: "value" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[debug:scope] message");
      expect(lines[0]).toContain('"key":"value"');
      console.log = originalConsoleLog;
    });
  });
});
