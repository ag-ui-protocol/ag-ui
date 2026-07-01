import posthog from "posthog-js";

if (!posthog.__loaded) {
  posthog.init("phc_XZdymVYjrph9Mi0xZYGNyCKexxgblXRR1jMENCtdz5Q", {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-01-30",
    capture_dead_clicks: false,
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
  });
}
