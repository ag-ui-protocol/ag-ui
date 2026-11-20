#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const configPath = process.env.AG_UI_CODEX_LAUNCH;
if (!configPath) throw new Error("Missing Codex launch configuration.");
const config: { executable: string; args: string[]; record: string } =
  JSON.parse(readFileSync(configPath, "utf8"));
const childEnvironment = { ...process.env };
delete childEnvironment.AG_UI_CODEX_LAUNCH;
let stopping = false;
let escalation: ReturnType<typeof setTimeout> | undefined;
function record(childPid?: number) {
  writeFileSync(
    `${config.record}.tmp`,
    JSON.stringify({ supervisor: process.pid, child: childPid }),
  );
  renameSync(`${config.record}.tmp`, config.record);
}
function signalGroup(signal: NodeJS.Signals) {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}
function groupExists() {
  if (child?.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}
function stop() {
  stopping = true;
  signalGroup("SIGTERM");
  if (!escalation) escalation = setTimeout(() => signalGroup("SIGKILL"), 1000);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, stop);
record();
const child = spawn(
  config.executable,
  [...config.args, ...process.argv.slice(2)],
  {
    env: childEnvironment,
    stdio: "inherit",
    detached: true,
  },
);
record(child.pid);
if (stopping) stop();
child.once("error", () => {
  if (escalation) clearTimeout(escalation);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
  if (!groupExists()) {
    if (escalation) clearTimeout(escalation);
    return;
  }
  stop();
  const wait = setInterval(() => {
    if (!groupExists()) {
      clearInterval(wait);
      if (escalation) clearTimeout(escalation);
    }
  }, 10);
  setTimeout(() => {
    clearInterval(wait);
    if (escalation) clearTimeout(escalation);
  }, 2000);
});
