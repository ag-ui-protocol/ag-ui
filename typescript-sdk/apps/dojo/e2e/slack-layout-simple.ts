import { Block, KnownBlock } from "@slack/types";
import { SummaryResults } from "playwright-slack-report/dist/src";
import { readFileSync, existsSync } from "fs";

interface VideoInfo {
  url: string;
  testName: string;
}

function getVideos(): VideoInfo[] {
  const videoFilePath = "test-results/video-urls.json";
  if (!existsSync(videoFilePath)) {
    return [];
  }

  try {
    const videoData = JSON.parse(readFileSync(videoFilePath, "utf8"));
    return videoData.videos || [];
  } catch (error) {
    console.error("Failed to read videos:", error);
    return [];
  }
}

export function generateSimpleLayout(
  summaryResults: SummaryResults
): Array<KnownBlock | Block> {
  const { passed, failed, skipped, tests } = summaryResults;

  // Summary
  const summary = {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        failed === 0
          ? `✅ All ${passed} tests passed!`
          : `✅ ${passed} passed • ❌ ${failed} failed • ⏭ ${skipped} skipped`,
    },
  };

  if (failed === 0) {
    return [summary];
  }

  // Get videos
  const videos = getVideos();
  const videoMap = new Map(videos.map((v) => [v.testName, v.url]));

  // List failed tests
  const failedTests = tests.filter(
    (test) => test.status === "failed" || test.status === "timedOut"
  );

  const failureLines = failedTests.map((test) => {
    const videoUrl = videoMap.get(test.name);
    const videoLink = videoUrl ? ` • <${videoUrl}|📹 Video>` : "";
    return `• *${test.name}*${videoLink}`;
  });

  const failures = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Failed Tests:*\n${failureLines.join("\n")}`,
    },
  };

  return [summary, failures];
}

export default generateSimpleLayout;
