export interface CliContext {
  cwd: string;
  now: Date;
}

export interface CliCommandResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface CliCommand {
  name: string;
  run: (args: string[], context: CliContext) => Promise<CliCommandResult>;
}
