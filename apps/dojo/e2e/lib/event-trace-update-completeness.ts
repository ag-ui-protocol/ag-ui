import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isTraceEvent, type TraceEvent } from "./event-trace-events";
import { getEventTraceDestination } from "./event-trace-golden";
import { exists } from "./event-trace-lanes";
import {
  planEventTraceUpdates,
  type EventTraceUpdateCandidate,
} from "./event-trace-update";

type ExistingJourneys = {
  readonly [journeyKey: string]: readonly TraceEvent[];
};
type SelectedLane = { lane: { id: string }; targets: readonly string[] };

async function readExistingJourneys(
  sourceUrl: string,
): Promise<ExistingJourneys> {
  if (!(await exists(fileURLToPath(sourceUrl)))) return {};
  const goldenModule: unknown = await import(sourceUrl);
  if (typeof goldenModule !== "object" || goldenModule === null) return {};
  const journeys: { [journeyKey: string]: readonly TraceEvent[] } = {};
  for (const exported of Object.values(goldenModule)) {
    if (typeof exported !== "object" || exported === null) continue;
    for (const value of Object.values(exported)) {
      if (!Array.isArray(value)) continue;
      const destination = getEventTraceDestination(value);
      if (destination?.sourceUrl !== sourceUrl) continue;
      if (!value.every(isTraceEvent)) {
        throw new Error(
          `Invalid existing Event trace ${sourceUrl}#${destination.journeyKey}: every event requires a string type; repair the baseline before capture; no golden files were written.`,
        );
      }
      journeys[destination.journeyKey] = value;
    }
  }
  return journeys;
}

export async function prepareCompleteEventTraceUpdates(options: {
  e2eRoot: string;
  selectedLanes: readonly SelectedLane[];
  candidates: readonly EventTraceUpdateCandidate[];
}) {
  const previousBySource = new Map<string, ExistingJourneys>();
  const selectedSources = new Map<string, string>();
  for (const { lane, targets } of options.selectedLanes) {
    for (const target of targets) {
      const sourceUrl = pathToFileURL(
        resolve(
          options.e2eRoot,
          target.replace(/\.spec\.ts$/, ".event-trace.ts"),
        ),
      ).href;
      const previous = await readExistingJourneys(sourceUrl);
      previousBySource.set(sourceUrl, previous);
      selectedSources.set(sourceUrl, lane.id);
      const captured = options.candidates.filter(
        (candidate) =>
          candidate.lane === lane.id && candidate.sourceUrl === sourceUrl,
      );
      const capturedKeys = new Set(
        captured.map((candidate) => candidate.journeyKey),
      );
      const missingKeys = Object.keys(previous).filter(
        (key) => !capturedKeys.has(key),
      );
      if (captured.length === 0 || missingKeys.length > 0) {
        throw new Error(
          `Incomplete Event trace capture for ${lane.id} ${target}: ${captured.length === 0 ? "no candidates" : "missing journeys"}${missingKeys.length ? ` [${missingKeys.join(", ")}]` : ""}; no golden files were written. Deliberate journey removal requires an explicit baseline and source edit.`,
        );
      }
    }
  }
  for (const candidate of options.candidates) {
    if (selectedSources.get(candidate.sourceUrl) !== candidate.lane) {
      throw new Error(
        `Event trace candidate is outside the selected lane/spec: ${candidate.lane} ${candidate.sourceUrl}; no golden files were written`,
      );
    }
  }
  return planEventTraceUpdates(options.candidates).map((update) => ({
    ...update,
    previous: previousBySource.get(update.sourceUrl) ?? {},
  }));
}
