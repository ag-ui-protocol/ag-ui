// Runs `playwright test` with the arguments given to `pnpm test`.
//
// `pnpm test -- <path>` passes the `--` on to Playwright, and Playwright
// treats every filter after `--` as absent, so the run grows to the whole
// suite. Dropping the `--` makes `pnpm test <path>` and `pnpm test -- <path>`
// run the same tests.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync("playwright", ["test", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
