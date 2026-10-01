#!/usr/bin/env node
// Start the Worker under `wrangler dev` (local workerd, no Cloudflare login)
// for the Dojo. CLOUDFLARE_INCLUDE_PROCESS_ENV exposes the OpenAI settings that
// run-dojo-everything.js injects as Worker bindings, without putting the API
// key on the command line where any process listing would show it.
import { spawn } from "node:child_process";

const port = process.env.PORT || "8030";

const child = spawn(
  "wrangler",
  [
    "dev",
    "--port",
    port,
    "--ip",
    "127.0.0.1",
    "--show-interactive-dev-session=false",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
      OPENAI_BASE_URL:
        process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
      OPENAI_MODEL: process.env.OPENAI_CHAT_MODEL_ID || "gpt-4o",
      WRANGLER_SEND_METRICS: "false",
      CI: process.env.CI ?? "true",
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
