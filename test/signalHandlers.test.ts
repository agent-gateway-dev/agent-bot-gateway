import { describe, expect, test } from "bun:test";
import { registerShutdownSignals } from "../src/app/signalHandlers.js";

describe("signal handlers", () => {
  test("registers process signal and fatal error handlers", () => {
    const originalOn = process.on.bind(process);
    const originalConsoleError = console.error;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const calls: number[] = [];
    const errorLines: string[] = [];

    console.error = (...args) => {
      errorLines.push(args.join(" "));
    };

    process.on = ((event: string, listener: (...args: unknown[]) => void) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.on;

    try {
      registerShutdownSignals((exitCode: number) => {
        calls.push(exitCode);
      });
      handlers.get("SIGINT")?.();
      handlers.get("SIGTERM")?.();
      handlers.get("unhandledRejection")?.(new Error("rejection boom"), Promise.resolve());
      handlers.get("unhandledRejection")?.(Object.assign(new Error("abort"), { name: "AbortError" }), Promise.resolve());
      handlers.get("uncaughtException")?.(new Error("exception boom"));
    } finally {
      process.on = originalOn;
      console.error = originalConsoleError;
    }

    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(calls).toEqual([0, 0, 1, 1]);
    expect(errorLines.some((line) => line.includes("[process] unhandledRejection: Error: rejection boom"))).toBe(true);
    expect(errorLines.some((line) => line.includes("[process] uncaughtException: Error: exception boom"))).toBe(true);
  });
});
