# CopilotKit Demo Smoke Tests

This repository houses Playwright-based smoke tests that run on a 6-hour schedule to make sure CopilotKit demo apps remain live and functional.

## 🔧 Local development

```bash
# Install deps
npm install

# Install browsers once
npx playwright install --with-deps

# Run the full suite
npm test
```

Playwright HTML reports are saved to `./playwright-report`.

## ➕ Adding a new smoke test

1. Duplicate an existing file in `tests/` or create `tests/<demo>.spec.ts`.
2. Use Playwright's `test` API—keep the test short (<30 s).
3. Commit and push—GitHub Actions will pick it up on the next scheduled run.

## 🚦 CI / CD

- `.github/workflows/scheduled-tests.yml` executes the suite every 6 hours and on manual trigger.
- Failing runs surface in the Actions tab; the HTML report is uploaded as an artifact.
- (Optional) Slack notifications can be wired by adding a step after the tests.
- Slack alert on failure is baked into the workflow. Just add `SLACK_WEBHOOK_URL` (Incoming Webhook) in repo secrets.
