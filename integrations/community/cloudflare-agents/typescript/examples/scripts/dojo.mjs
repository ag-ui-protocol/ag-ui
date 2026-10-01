#!/usr/bin/env node
// Start the Worker under `wrangler dev` (local workerd, no Cloudflare login)
// for the Dojo. Worker bindings do not read process.env, so forward the
// OpenAI settings that run-dojo-everything.js injects as `--var` overrides.
import { spawn } from "node:child_process";

const port = process.env.PORT || "8027";
const vars = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_CHAT_MODEL_ID || "gpt-4o",
};

const args = [
  "dev",
  "--port",
  port,
  "--ip",
  "127.0.0.1",
  "--show-interactive-dev-session=false",
  ...Object.entries(vars).flatMap(([key, value]) => [
    "--var",
    `${key}:${value}`,
  ]),
];

const child = spawn("wrangler", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    CI: process.env.CI ?? "true",
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
