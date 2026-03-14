import { describe, expect, test, mock } from "bun:test";
import { wireBridgeListeners } from "../src/app/wireListeners.js";

describe("wire listeners", () => {
  test("wireBridgeListeners filters rollout path errors from stderr", async () => {
    const mockCodex = {
      on: mock(() => {})
    };
    const mockDiscord = {
      on: mock(() => {})
    };
    const mockHandleNotification = mock(() => {});
    const mockHandleServerRequest = mock(() => {});
    const mockHandleChannelCreate = mock(() => {});
    const mockHandleMessage = mock(() => {});
    const mockHandleInteraction = mock(() => {});

    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const errorLog = [];
    const warnLog = [];

    console.error = (...args) => {
      errorLog.push(args.join(" "));
    };
    console.warn = (...args) => {
      warnLog.push(args.join(" "));
    };

    try {
      wireBridgeListeners({
        codex: mockCodex,
        discord: mockDiscord,
        handleNotification: mockHandleNotification,
        handleServerRequest: mockHandleServerRequest,
        handleChannelCreate: mockHandleChannelCreate,
        handleMessage: mockHandleMessage,
        handleInteraction: mockHandleInteraction
      });

      expect(mockCodex.on.mock.calls.length).toBeGreaterThan(0);

      const stderrCall = mockCodex.on.mock.calls.find(call => call[0] === "stderr");
      expect(stderrCall).toBeDefined();

      const stderrHandler = stderrCall[1];

      errorLog.length = 0;
      warnLog.length = 0;

      stderrHandler("state db missing rollout path for thread 019ce72a-144e-79c2-9dc8-a08720e5661c");
      expect(errorLog.length).toBe(0);
      expect(warnLog.length).toBe(1);
      expect(warnLog[0]).toContain("Ignoring missing rollout path error");
      expect(warnLog[0]).toContain("state db missing rollout path for thread");

      errorLog.length = 0;
      warnLog.length = 0;

      stderrHandler("codex_core::state_db: list_threads_with_db_fallback, falling_back");
      expect(errorLog.length).toBe(0);
      expect(warnLog.length).toBe(0);

      errorLog.length = 0;
      warnLog.length = 0;

      stderrHandler("ERROR real problem: something went wrong");
      expect(errorLog.length).toBe(1);
      expect(errorLog[0]).toContain("[codex]");
      expect(errorLog[0]).toContain("ERROR real problem: something went wrong");
      expect(warnLog.length).toBe(0);
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }
  });

  test("adds catch handlers for notification and serverRequest listeners", async () => {
    const codexHandlers = new Map<string, (payload: unknown) => void>();
    const mockCodex = {
      on: mock((event: string, handler: (payload: unknown) => void) => {
        codexHandlers.set(event, handler);
      })
    };
    const mockDiscord = {
      on: mock(() => {})
    };
    const originalConsoleError = console.error;
    const errorLog: string[] = [];
    console.error = (...args) => {
      errorLog.push(args.join(" "));
    };

    try {
      wireBridgeListeners({
        codex: mockCodex,
        discord: mockDiscord,
        handleNotification: async () => {
          throw new Error("notification boom");
        },
        handleServerRequest: async () => {
          throw new Error("server request boom");
        },
        handleChannelCreate: mock(() => {}),
        handleMessage: mock(() => {}),
        handleInteraction: mock(() => {})
      });

      codexHandlers.get("notification")?.({ method: "turn/completed" });
      codexHandlers.get("serverRequest")?.({ method: "item/fileChange/requestApproval" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorLog.some((line) => line.includes("notification handler failed for turn/completed: notification boom"))).toBe(true);
      expect(
        errorLog.some((line) => line.includes("serverRequest handler failed for item/fileChange/requestApproval: server request boom"))
      ).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
