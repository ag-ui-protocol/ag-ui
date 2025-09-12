import { defineConfig, ReporterDescription } from "@playwright/test";
import { generateSimpleLayout } from "./slack-layout-simple";



function getReporters(): ReporterDescription[] {
  const videoReporter: ReporterDescription = [
    "./reporters/s3-video-reporter.ts",
    {
      outputFile: "test-results/video-urls.json",
      uploadVideos: true,
    },
  ];
  const s3Reporter: ReporterDescription = [
      "./node_modules/playwright-slack-report/dist/src/SlackReporter.js",
      {
        slackWebHookUrl: process.env.SLACK_WEBHOOK_URL,
        sendResults: "always", // always send results
        maxNumberOfFailuresToShow: 10,
        layout: generateSimpleLayout, // Use our simple layout
      },
    ];
  const githubReporter: ReporterDescription = ["github"];
  const htmlReporter: ReporterDescription = ["html", { open: "never" }];
  const cleanReporter: ReporterDescription = ["./clean-reporter.js"];

  const addVideoAndSlack = process.env.SLACK_WEBHOOK_URL && process.env.AWS_S3_BUCKET_NAME;

  return [
    process.env.CI ? githubReporter : undefined,
    addVideoAndSlack ? videoReporter : undefined,
    addVideoAndSlack ? s3Reporter : undefined,
    htmlReporter,
    cleanReporter,
  ].filter(Boolean) as ReporterDescription[];
}

function getBaseUrl(): string {
  if (process.env.BASE_URL) {
    return new URL(process.env.BASE_URL).toString();
  }
  console.error("BASE_URL is not set");
  process.exit(1);
}

export default defineConfig({
  timeout: process.env.CI ? 300_000 : 120_000, // 5min in CI, 2min locally for AI tests
  testDir: "./tests",
  retries: process.env.CI ? 3 : 0, // More retries for flaky AI tests in CI, 0 for local
  // Make this sequential for now to avoid race conditions
  workers: process.env.CI ? 1 : undefined,
  fullyParallel: process.env.CI ? false : true,
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
    baseURL: getBaseUrl(),
  },
  expect: {
    timeout: 120_000, // 2 minutes for AI-generated content to appear
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
  reporter: getReporters(),
});
