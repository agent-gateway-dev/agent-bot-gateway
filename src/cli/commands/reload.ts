import type { CliCommandResult } from "../../types/events.js";

export async function runReloadCommand(_args: string[]): Promise<CliCommandResult> {
  return {
    ok: true,
    message: "reload: scaffold ready",
    details: {
      note: "Phase 1 placeholder. Host-managed restart signal will be added in Phase 6."
    }
  };
}
