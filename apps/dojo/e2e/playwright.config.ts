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
  timeout: process.env.CI ? 180_000 : 120_000, // 3min in CI, 2min locally
  testDir: "./tests",
  retries: process.env.CI ? 3 : 0, // More retries for flaky AI tests in CI, 0 for local
  workers: process.env.CI ? 2 : undefined,
  fullyParallel: false,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Video recording for failed tests
    video: {
      mode: "retain-on-failure", // Only keep videos for failed tests
      size: { width: 1280, height: 720 },
    },
    // Fail fast on broken UI so retryOnAIFailure can retry sooner
    navigationTimeout: 30_000, // 30s for page loads
    actionTimeout: 15_000, // 15s for clicks/fills — if it's not there, it's broken
    // Test isolation - ensure clean state between tests
    testIdAttribute: "data-testid",
    baseURL: getBaseUrl(),
  },
  expect: {
    timeout: 60_000, // 60s for AI-generated content; explicit poll() timeouts override
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
