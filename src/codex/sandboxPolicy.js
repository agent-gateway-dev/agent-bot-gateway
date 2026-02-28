export function createSandboxPolicyResolver(deps) {
  const { path, execFileAsync, extraWritableRoots } = deps;
  const workspaceWritableRootsCache = new Map();

  async function buildSandboxPolicyForTurn(mode, cwd) {
    if (mode === "danger-full-access") {
      return { type: "dangerFullAccess" };
    }
    if (mode === "read-only") {
      return { type: "readOnly", access: { type: "fullAccess" } };
    }
    if (mode === "workspace-write") {
      const writableRoots = await resolveWorkspaceWritableRoots(cwd);
      return {
        type: "workspaceWrite",
        writableRoots,
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    }
    return null;
  }

  async function resolveWorkspaceWritableRoots(cwd) {
    const key = path.resolve(cwd);
    const cached = workspaceWritableRootsCache.get(key);
    if (cached) {
      return cached;
    }

    const roots = new Set([key, ...extraWritableRoots]);
    const gitRoots = await discoverGitWritableRoots(key);
    for (const root of gitRoots) {
      roots.add(path.resolve(root));
    }

    const resolved = [...roots];
    workspaceWritableRootsCache.set(key, resolved);
    return resolved;
  }

  async function discoverGitWritableRoots(cwd) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
        { timeout: 3000, maxBuffer: 1024 * 1024 }
      );
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && path.isAbsolute(line));
    } catch {
      return [];
    }
  }

  return {
    buildSandboxPolicyForTurn
  };
}
