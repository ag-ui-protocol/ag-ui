import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAgentAdapter } from "../src/index";
import { createCodexServer } from "./http";

async function main() {
  const port = Number(process.env.PORT ?? 8032);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be between 0 and 65535.");
  if (
    process.env.CODEX_TEST_MODE !== undefined &&
    process.env.CODEX_TEST_MODE !== "1"
  )
    throw new Error("CODEX_TEST_MODE must be 1 when set.");
  if (
    process.env.CODEX_TEST_MODE === "1" &&
    (!process.env.CODEX_PATH || !process.env.CODEX_FIXTURE_DIR)
  ) {
    throw new Error("Test mode requires CODEX_PATH and CODEX_FIXTURE_DIR.");
  }
  const workingDirectory =
    process.env.CODEX_WORKING_DIRECTORY ??
    (await mkdtemp(join(tmpdir(), "ag-ui-codex-workspace-")));
  await mkdir(workingDirectory, { recursive: true });
  if (!process.env.CODEX_WORKING_DIRECTORY)
    execFileSync("git", ["init", "--quiet", workingDirectory]);
  const agent = new CodexAgentAdapter({
    codexOptions: {
      apiKey: process.env.CODEX_API_KEY,
      codexPathOverride: process.env.CODEX_PATH,
    },
    threadOptions: {
      workingDirectory,
      model: process.env.CODEX_MODEL,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    },
  });
  const server = createCodexServer({
    agent,
    allowedOrigins: process.env.CODEX_ALLOWED_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    const address = server.address();
    if (address && typeof address !== "string")
      process.stdout.write(`Codex AG-UI server listening on ${address.port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
}

main().catch(() => {
  process.stderr.write(
    "Codex server could not start. Check host configuration.\n",
  );
  process.exitCode = 1;
});
