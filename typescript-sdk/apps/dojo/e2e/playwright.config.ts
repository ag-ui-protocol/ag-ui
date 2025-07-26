import { defineConfig } from "@playwright/test";
import { generateSimpleLayout } from "./slack-layout-simple";

export default defineConfig({
  timeout: process.env.CI ? 300_000 : 120_000, // 5min in CI, 2min locally for AI tests
  workers: 1, // Serial execution to avoid race conditions and AI service conflicts
  testDir: "./tests",
  retries: process.env.CI ? 3 : 0, // More retries for flaky AI tests in CI, 0 for local
  fullyParallel: false, // Serial execution for deterministic AI test results
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Video recording for failed tests
    video: {
      mode: "retain-on-failure", // Only keep videos for failed tests
      size: { width: 1280, height: 720 },
    },
    // Increased timeouts for AI interactions
    navigationTimeout: 90_000, // 1.5 minutes for slow AI app loads
    actionTimeout: 60_000, // 1 minute for AI-driven actions (clicking, filling)
    // Test isolation - ensure clean state between tests
    testIdAttribute: "data-testid",
  },
  expect: {
    timeout: 90_000, // 1.5 minutes for AI-generated content to appear
  },
  // Test isolation between each test
  projects: [
    {
      name: "chromium",
      use: {
        ...require("@playwright/test").devices["Desktop Chrome"],
        // Force new context for each test to ensure isolation
        contextOptions: {
          // Clear all data between tests
          storageState: undefined,
        },
      },
    },
  ],
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { open: "never" }],
        // S3 video uploader (runs first to upload videos)
        [
          "./reporters/s3-video-reporter.ts",
          {
            outputFile: "test-results/video-urls.json",
            uploadVideos: true,
          },
        ],
        // Slack notifications (runs after videos are uploaded)
        [
          "./node_modules/playwright-slack-report/dist/src/SlackReporter.js",
          {
            slackWebHookUrl: process.env.SLACK_WEBHOOK_URL,
            sendResults: "always", // always send results
            maxNumberOfFailuresToShow: 10,
            layout: generateSimpleLayout, // Use our simple layout
          },
        ],
      ]
    : process.env.SLACK_WEBHOOK_URL && process.env.AWS_S3_BUCKET_NAME
    ? [
        // Full local testing with S3 + Slack (when both are configured)
        [
          "./reporters/s3-video-reporter.ts",
          {
            outputFile: "test-results/video-urls.json",
            uploadVideos: true,
          },
        ],
        [
          "./node_modules/playwright-slack-report/dist/src/SlackReporter.js",
          {
            slackWebHookUrl: process.env.SLACK_WEBHOOK_URL,
            sendResults: "always",
            maxNumberOfFailuresToShow: 10,
            layout: generateSimpleLayout,
          },
        ],
        ["html", { open: "never" }],
      ]
    : [
        // Standard local testing
        ["./clean-reporter.js"],
        ["html", { open: "never" }],
      ],
});
