import type { Response, TestInfo } from "@playwright/test";
import { test as isolatedTest, expect } from "./test-isolation-helper";
import type { TraceEvent } from "./lib/event-trace-events";
import { withEventTraceAssertion } from "./lib/event-trace-assertion";
import { defineEventTrace } from "./lib/event-trace-golden";
import { EventTraceRecorder } from "./lib/event-trace-recorder";
import { isEventTraceResponse } from "./lib/event-trace-response";
import {
  assertEventTraceMatches,
  createEventTraceUpdateCandidate,
  writeEventTraceUpdateCandidate,
} from "./lib/event-trace-update";

type EventTraceAssertions = {
  expectJourney(
    expected: readonly TraceEvent[],
    assertCaptured?: (actual: readonly TraceEvent[]) => void | Promise<void>,
  ): Promise<void>;
};

function getUpdateMode() {
  const stagingDirectory = process.env.EVENT_TRACE_UPDATE_STAGING_DIR;
  const lane = process.env.EVENT_TRACE_UPDATE_LANE;
  if (!stagingDirectory && !lane) return undefined;
  if (!stagingDirectory || !lane) {
    throw new Error(
      "Event trace update mode requires EVENT_TRACE_UPDATE_STAGING_DIR and EVENT_TRACE_UPDATE_LANE",
    );
  }
  return { stagingDirectory, lane };
}

async function attachJson(
  testInfo: Pick<TestInfo, "attach">,
  name: string,
  value: unknown,
) {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
}

async function attachEventTraceArtifacts(
  testInfo: Pick<TestInfo, "attach">,
  recorder: EventTraceRecorder,
  expected?: readonly TraceEvent[],
) {
  const artifacts = recorder.getArtifacts();
  await attachJson(testInfo, "event-trace-raw-streams", artifacts.rawStreams);
  await attachJson(
    testInfo,
    "event-trace-normalized-journey",
    artifacts.normalizedJourney ?? {
      captureError: artifacts.captureError,
    },
  );
  if (expected) {
    await attachJson(testInfo, "event-trace-expected-journey", expected);
  }
}

function observeResponse(response: Response, recorder: EventTraceRecorder) {
  const request = response.request();
  if (
    !isEventTraceResponse({
      method: request.method(),
      url: response.url(),
      contentType: response.headers()["content-type"],
    })
  ) {
    return;
  }

  recorder.observeStream({
    url: response.url(),
    body: response.body().then((body) => body.toString("utf8")),
  });
}

export async function runEventTraceFixture(
  page: {
    on(event: "response", listener: (response: Response) => void): void;
    off(event: "response", listener: (response: Response) => void): void;
  },
  provide: (eventTrace: EventTraceAssertions) => Promise<void>,
  testInfo: Pick<TestInfo, "attach" | "testId" | "status" | "expectedStatus">,
) {
  const recorder = new EventTraceRecorder();
  const updateMode = getUpdateMode();
  let artifactsAttempted = false;
  const attachArtifactsOnce = async (expected?: readonly TraceEvent[]) => {
    if (artifactsAttempted) return;
    // Mark before awaiting: a failed attachment must not be retried by teardown.
    artifactsAttempted = true;
    await attachEventTraceArtifacts(testInfo, recorder, expected);
  };
  const responseListener = (response: Response) => {
    observeResponse(response, recorder);
  };
  page.on("response", responseListener);

  const eventTrace: EventTraceAssertions = {
    expectJourney: async (expected, assertCaptured) => {
      try {
        await recorder.expectJourney(
          expected,
          withEventTraceAssertion(async (actual, golden) => {
            if (!updateMode) {
              assertEventTraceMatches(actual, golden);
              return;
            }

            const candidate = createEventTraceUpdateCandidate({
              lane: updateMode.lane,
              expected: golden,
              actual,
            });
            await writeEventTraceUpdateCandidate({
              stagingDirectory: updateMode.stagingDirectory,
              testId: testInfo.testId,
              candidate,
            });
          }, assertCaptured),
        );
      } catch (error) {
        try {
          await attachArtifactsOnce(expected);
        } catch (attachmentError) {
          throw new AggregateError(
            [error, attachmentError],
            "AG-UI journey failed and diagnostic attachment also failed",
          );
        }
        throw error;
      }
    },
  };

  const errors: unknown[] = [];
  try {
    await provide(eventTrace);
  } catch (error) {
    errors.push(error);
  }

  const testAlreadyFailed =
    errors.length > 0 || testInfo.status !== testInfo.expectedStatus;
  try {
    await recorder.finalize({ testAlreadyFailed });
  } catch (error) {
    errors.push(error);
  }
  if (testAlreadyFailed || errors.length > 0) {
    try {
      await attachArtifactsOnce();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    page.off("response", responseListener);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "AG-UI fixture failed with additional diagnostic or cleanup errors",
    );
  }
}

export const test = isolatedTest.extend<{ eventTrace: EventTraceAssertions }>({
  eventTrace: [
    async ({ page }, provide, testInfo) => {
      await runEventTraceFixture(page, provide, testInfo);
    },
    { auto: true },
  ],
});

export { defineEventTrace, expect };
export type { TraceEvent };
