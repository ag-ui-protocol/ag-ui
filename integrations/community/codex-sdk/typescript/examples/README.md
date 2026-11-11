# Run Codex text chat

Start the standalone server from the repository root.

```sh
pnpm exec nx run @ag-ui/codex-sdk:build
HOST=127.0.0.1 pnpm exec nx run @ag-ui/codex-sdk:start
```

Use native Codex login or set `CODEX_API_KEY` on the host. Set `CODEX_MODEL` only to a model available to your account. Set `CODEX_WORKING_DIRECTORY` to a dedicated scratch Git repository, or let the server create one. Keep provider credentials on the server.

## Connect Flutter directly

In a second terminal, open `sdks/community/dart/example`.

```sh
flutter pub get
flutter run -d chrome --dart-define=AG_UI_BACKEND=codex --dart-define=AG_UI_BASE_URL=http://127.0.0.1:8032
```

Select Agentic Chat. Send your name, then ask for it in a second turn. The page retains one public thread and the completed assistant history. The web Dojo does not need to run. Codex mode supports text chat only. Without `AG_UI_BACKEND=codex`, Flutter retains its Go endpoints.

## Connect the web Dojo

```sh
node apps/dojo/scripts/prep-dojo-everything.js --only dojo,codex-sdk-typescript
node apps/dojo/scripts/run-dojo-everything.js --only dojo,codex-sdk-typescript
```

Select Codex SDK in the sidebar. Its text-chat page registers no frontend tools.

## Run without a provider

Select the fixture explicitly. It is a test executable, not a Codex provider.

```sh
CODEX_TEST_MODE=1 CODEX_FIXTURE_DIR=/tmp/ag-ui-codex-fixture CODEX_PATH="$PWD/integrations/community/codex-sdk/typescript/examples/testing/codex-exec.mjs" HOST=127.0.0.1 pnpm exec nx run @ag-ui/codex-sdk:start
```

The fixture requires Node.js on PATH. It records native session state only in the selected temporary directory. The normal server never substitutes the fixture for missing credentials.

## Verify the real provider

Start the server with production Codex and host credentials. Do not set `CODEX_TEST_MODE`. In another terminal, run the opt-in procedure from the repository root.

```sh
AG_UI_SMOKE_URL=http://127.0.0.1:8032/agentic_chat pnpm exec nx run @ag-ui/codex-sdk:smoke
```

The smoke checks native two-turn continuation and independent-thread isolation through `HttpAgent`. Repeat the two-turn conversation in the actual Flutter app. Record SDK and CLI versions, platform, displayed replies, and process exit after cancellation separately. Deterministic fixture tests do not satisfy this provider gate.
