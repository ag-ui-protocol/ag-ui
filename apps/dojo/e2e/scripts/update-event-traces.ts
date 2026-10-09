import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isTraceEvent } from "../lib/event-trace-events";
import { exists, resolveEventTraceLanes } from "../lib/event-trace-lanes";
import { runEventTraceLane } from "../lib/event-trace-runner";
import { withEventTraceUpdateWorkspace } from "../lib/event-trace-update-workspace";
import { prepareCompleteEventTraceUpdates } from "../lib/event-trace-update-completeness";
import { publishEventTraceUpdates } from "../lib/event-trace-update-publication";
import {
  type EventTraceUpdateCandidate,
  renderEventTraceModule,
  summarizeEventTraceDiff,
} from "../lib/event-trace-update";

type CliOptions = {
  all: boolean;
  spec?: string;
  reason: string;
  integration: "langgraph" | "strands";
};

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(e2eRoot, "tests");
const stagingRoot = join(e2eRoot, ".event-trace-update");

function readOptionValue(args: readonly string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args: readonly string[]): CliOptions {
  let all = false;
  let spec: string | undefined;
  let reason: string | undefined;
  let integration: CliOptions["integration"] = "langgraph";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--spec") {
      spec = readOptionValue(args, index, "--spec");
      index += 1;
    } else if (arg === "--reason") {
      reason = readOptionValue(args, index, "--reason");
      index += 1;
    } else if (arg === "--integration") {
      const value = readOptionValue(args, index, "--integration");
      if (value !== "langgraph" && value !== "strands") {
        throw new Error(`Unknown integration: ${value}`);
      }
      integration = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (all === Boolean(spec)) {
    throw new Error("Choose exactly one of --all or --spec <name>");
  }
  if (!reason?.trim()) {
    throw new Error("Event trace updates require --reason <explanation>");
  }
  if (spec && !/^[A-Za-z0-9_-]+$/.test(spec)) {
    throw new Error(`Invalid spec name: ${spec}`);
  }

  return { all, spec, reason, integration };
}

async function findJsonFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findJsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function parseCandidate(
  value: unknown,
  path: string,
): EventTraceUpdateCandidate {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lane" in value) ||
    typeof value.lane !== "string" ||
    !("sourceUrl" in value) ||
    typeof value.sourceUrl !== "string" ||
    !("journeyKey" in value) ||
    typeof value.journeyKey !== "string" ||
    !("events" in value) ||
    !Array.isArray(value.events) ||
    !value.events.every(isTraceEvent)
  ) {
    throw new Error(`Invalid Event trace update candidate: ${path}`);
  }

  return {
    lane: value.lane,
    sourceUrl: value.sourceUrl,
    journeyKey: value.journeyKey,
    events: value.events,
  };
}

async function readCandidates(stagingDirectory: string) {
  const files = await findJsonFiles(stagingDirectory);
  return Promise.all(
    files.map(async (path) => {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return parseCandidate(value, path);
    }),
  );
}

function goldenExportName(path: string) {
  const stem = basename(path, ".event-trace.ts");
  const camel = stem.replaceAll(/[^A-Za-z0-9_$]+(.)/g, (_, character) =>
    character.toUpperCase(),
  );
  return `${camel}EventTrace`;
}

function goldenImportPath(path: string) {
  const helper = join(e2eRoot, "event-trace-test.ts");
  const importPath = relative(dirname(path), helper)
    .split(sep)
    .join("/")
    .replace(/\.ts$/, "");
  return importPath.startsWith(".") ? importPath : `./${importPath}`;
}

function validateGoldenPath(sourceUrl: string) {
  const path = resolve(fileURLToPath(sourceUrl));
  if (!isAbsolute(path) || !path.startsWith(`${testsRoot}${sep}`)) {
    throw new Error(`Refusing to update golden outside ${testsRoot}: ${path}`);
  }
  if (!path.endsWith(".event-trace.ts")) {
    throw new Error(`Event trace must end in .event-trace.ts: ${path}`);
  }
  return path;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!process.env.BASE_URL) {
    throw new Error(
      "BASE_URL is required; start Dojo and the selected integration backends first",
    );
  }

  const selectedLanes = await resolveEventTraceLanes(e2eRoot, options);
  if (selectedLanes.length === 0) {
    throw new Error(
      options.spec
        ? `No matching ${options.integration} spec found for ${options.spec}`
        : `No ${options.integration} Event trace test directories were found`,
    );
  }

  await withEventTraceUpdateWorkspace(
    stagingRoot,
    async ({ stagingDirectory, publish }) => {
      for (const { lane, targets } of selectedLanes) {
        runEventTraceLane({ lane, targets, e2eRoot, stagingDirectory });
      }

      const candidates = await readCandidates(stagingDirectory);
      if (candidates.length === 0) {
        throw new Error(
          "The selected tests produced no Event trace candidates",
        );
      }
      for (const { lane } of selectedLanes) {
        if (!candidates.some((candidate) => candidate.lane === lane.id)) {
          throw new Error(
            `${lane.id} completed without leaving event trace candidates; no golden files were written`,
          );
        }
      }

      await publish(async () => {
        const updates = await prepareCompleteEventTraceUpdates({
          e2eRoot,
          selectedLanes,
          candidates,
        });
        const pendingWrites: Array<{
          path: string;
          temporaryPath: string;
          content: string;
        }> = [];

        for (const update of updates) {
          const path = validateGoldenPath(update.sourceUrl);
          const previous = update.previous;
          const summary = summarizeEventTraceDiff(previous, update.journeys);
          const label = relative(e2eRoot, path);
          if (summary.length === 0) {
            console.log(`${label}: no semantic changes`);
            continue;
          }

          console.log(`\n${label}`);
          for (const line of summary) console.log(`  ${line}`);

          pendingWrites.push({
            path,
            temporaryPath: join(
              stagingDirectory,
              `golden-${pendingWrites.length}.tmp`,
            ),
            content: await renderEventTraceModule({
              exportName: goldenExportName(path),
              importPath: goldenImportPath(path),
              reason: options.reason,
              journeys: update.journeys,
            }),
          });
        }

        await publishEventTraceUpdates(pendingWrites, stagingDirectory);

        console.log(`\nUpdated ${pendingWrites.length} Event trace file(s).`);
        console.log(
          "Review every semantic change and first ask whether the implementation regressed.",
        );
      });
    },
  );
}

await main();
