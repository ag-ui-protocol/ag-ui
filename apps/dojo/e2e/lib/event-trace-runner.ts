import { createRequire } from "node:module";
import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

type LaneOptions = {
  lane: { id: string; playwrightSuite: string };
  targets: string[];
  e2eRoot: string;
  stagingDirectory: string;
};

type SpawnLane = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error" | "signal">;

export function runEventTraceLane(
  { lane, targets, e2eRoot, stagingDirectory }: LaneOptions,
  spawn: SpawnLane = spawnSync,
) {
  const require = createRequire(import.meta.url);
  const result = spawn(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      // Playwright treats positional arguments as regexes against full paths.
      ...targets.map(
        (target) =>
          `(?:^|[/\\\\])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
      "--retries=0",
      "--workers=1",
      "--timeout=120000",
    ],
    {
      cwd: e2eRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        EVENT_TRACE_UPDATE_LANE: lane.id,
        EVENT_TRACE_UPDATE_STAGING_DIR: stagingDirectory,
        PLAYWRIGHT_SUITE: lane.playwrightSuite,
      },
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${lane.id} Event trace update lane failed (${result.signal ? `signal ${result.signal}` : `exit status ${result.status}`}); no golden files were written`,
    );
  }
}
