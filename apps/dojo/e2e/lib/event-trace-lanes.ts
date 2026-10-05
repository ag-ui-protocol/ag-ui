import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

type LaneOptions = {
  all: boolean;
  spec?: string;
  integration: "langgraph" | "strands";
};

const lanes = [
  {
    id: "typescript",
    testDirectory: "langgraphTypescriptTests",
    playwrightSuite: "langgraph-typescript",
  },
  {
    id: "python",
    testDirectory: "langgraphPythonTests",
    playwrightSuite: "langgraph-python",
  },
  {
    id: "fastapi",
    testDirectory: "langgraphFastAPITests",
    playwrightSuite: "langgraph-fastapi",
  },
] as const;

const strandsLanes = [
  {
    id: "strands-typescript",
    testDirectory: "awsStrandsTypescriptTests",
    playwrightSuite: "aws-strands-typescript",
  },
  {
    id: "strands-python",
    testDirectory: "awsStrandsTests",
    playwrightSuite: "aws-strands",
  },
] as const;

type Lane = (typeof lanes)[number] | (typeof strandsLanes)[number];

export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Missing optional specs and not-yet-created golden files are expected.
      return false;
    }
    throw error;
  }
}

async function laneTargets(
  e2eRoot: string,
  lane: Lane,
  options: LaneOptions,
): Promise<string[]> {
  const directory = join("tests", lane.testDirectory);
  if (!(await exists(join(e2eRoot, directory)))) return [];
  if (!options.all) {
    const target = join(directory, `${options.spec}.spec.ts`);
    return (await exists(join(e2eRoot, target))) ? [target] : [];
  }
  // Only instrumented journeys can produce capture candidates. Other browser
  // tests still run in the normal suite, but do not belong in baseline updates.
  const entries = await readdir(join(e2eRoot, directory));
  return entries
    .filter((name) => name.endsWith(".event-trace.ts"))
    .map((companion) => {
      const spec = companion.replace(/\.event-trace\.ts$/, ".spec.ts");
      if (!entries.includes(spec)) {
        throw new Error(
          `Orphaned event trace companion ${join(directory, companion)}: missing spec ${join(directory, spec)}; restore the spec or remove its obsolete companion before capture`,
        );
      }
      return spec;
    })
    .sort()
    .map((name) => join(directory, name));
}

export async function resolveEventTraceLanes(
  e2eRoot: string,
  options: LaneOptions,
) {
  const selected = await Promise.all(
    (options.integration === "strands" ? strandsLanes : lanes).map(
      async (lane) => ({
        lane,
        targets: await laneTargets(e2eRoot, lane, options),
      }),
    ),
  );
  if (options.integration === "strands") {
    for (const { lane, targets } of selected) {
      if (targets.length === 0) {
        throw new Error(
          `${lane.id} has no matching ${options.spec ?? "instrumented"} specs; both Strands lanes are required before capture`,
        );
      }
    }
    const expected = selected[0].targets.map((target) => basename(target));
    for (const { lane, targets } of selected.slice(1)) {
      const actual = targets.map((target) => basename(target));
      if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== expected[index])
      ) {
        throw new Error(
          `Strands lanes must capture the same instrumented specs: ${selected[0].lane.id} [${expected.join(", ")}] versus ${lane.id} [${actual.join(", ")}]`,
        );
      }
    }
  }
  return selected.filter(({ targets }) => targets.length > 0);
}
