import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexOptions, Thread, ThreadOptions } from "@openai/codex-sdk";

export type CodexThread = Pick<Thread, "id" | "runStreamed">;
export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
  dispose?: () => Promise<void>;
}

const localRequire = createRequire(
  typeof __filename === "string" ? __filename : import.meta.url,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

export async function createCodex(options: CodexOptions): Promise<CodexClient> {
  if (process.platform === "win32")
    throw new Error(
      "Codex process supervision currently requires a POSIX host.",
    );
  const { Codex } = await import("@openai/codex-sdk");
  const packageRoot = dirname(
    localRequire.resolve("@ag-ui/codex-sdk/package.json"),
  );
  const executable = options.codexPathOverride ?? process.execPath;
  const args = options.codexPathOverride
    ? []
    : [
        join(
          dirname(localRequire.resolve("@openai/codex/package.json")),
          "bin/codex.js",
        ),
      ];
  const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-process-"));
  const record = join(directory, "process.json");
  const config = join(directory, "launch.json");
  const launcher = join(directory, "codex-launch");
  const source = await readFile(
    join(packageRoot, "dist/process-launcher.js"),
    "utf8",
  );
  await writeFile(
    launcher,
    `#!${process.execPath}\n${source.replace(/^#![^\n]*\n/, "")}`,
  );
  await chmod(launcher, 0o700);
  await writeFile(config, JSON.stringify({ executable, args, record }), {
    mode: 0o600,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.AG_UI_CODEX_LAUNCH = config;
  const codex = new Codex({
    ...options,
    env: environment,
    codexPathOverride: launcher,
  });
  let disposal: Promise<void> | undefined;
  async function cleanup() {
    let processes: { supervisor: number; child?: number } | undefined;
    try {
      processes = JSON.parse(await readFile(record, "utf8"));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (processes) {
      const { supervisor, child } = processes;
      const signal = (pid: number, value: NodeJS.Signals) => {
        try {
          process.kill(pid, value);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          )
            throw error;
        }
      };
      if (alive(supervisor)) signal(supervisor, "SIGTERM");
      if (child !== undefined && alive(-child)) signal(-child, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (alive(supervisor) || (child !== undefined && alive(-child))) {
        if (Date.now() >= deadline) {
          if (child !== undefined && alive(-child)) signal(-child, "SIGKILL");
          if (alive(supervisor)) signal(supervisor, "SIGKILL");
          throw new Error("Codex process cleanup exceeded its deadline.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  return {
    startThread: (threadOptions) => codex.startThread(threadOptions),
    resumeThread: (id, threadOptions) => codex.resumeThread(id, threadOptions),
    dispose() {
      return (disposal ??= cleanup());
    },
  };
}
