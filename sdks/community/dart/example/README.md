# AG-UI Flutter Dojo

A Flutter example using the parent Dart SDK and the paired [Go example server](../../../go/example/server). The application replaces the previous CLI example. This first import preserves the source features; the following integration slices repair lifecycle, protocol reconciliation, and deterministic verification.

## Toolchain and installation

Use Flutter **3.47.1** (Dart **3.13.1**) and Git LFS. The application requires Dart >=3.9 and Flutter >=3.35; the parent SDK retains its own independent SDK floor.

```bash
# From the repository root:
git lfs pull
cd sdks/community/dart/example
flutter pub get
```

The `ag_ui` dependency resolves to `../`. No sibling checkout, Python backend, pnpm, or private module is needed.

## Run the pair

In terminal 1, with a valid `OPENAI_API_KEY` already set in that terminal:

```bash
# From the repository root:
cd sdks/community/go/example/server
go run ./cmd
```

In terminal 2:

```bash
# From the repository root:
cd sdks/community/dart/example
flutter run -d chrome
# Native macOS runner:
flutter run -d macos
```

The desktop/web default is `http://127.0.0.1:8080`. For a different Go `PORT` or host, compile with `flutter run -d chrome --dart-define=AG_UI_BASE_URL=http://127.0.0.1:9090`. Exporting `AG_UI_BASE_URL` in the shell alone does not configure Flutter. Provider credentials belong only in the Go server environment.

Web and macOS are the required validation targets for this migration; build and interactive results will be recorded after integration. Android, iOS, Linux and Windows runners are retained and currently unverified. Physical devices need a reachable host and explicit Go bind address; Android emulators generally need their host bridge address. No mobile HTTP support is claimed.

## Source provenance

| Source | Revision | Disposition |
| --- | --- | --- |
| `github.com/mattsp1290/ag_ui_demo` | `1d1fa327d70d416cac909288497a6a07f94b313d` | Imported application, three tests, six platform runners and intentional assets. Included local optional Pods includes in both iOS xcconfigs, iOS/macOS Podfiles, and resolved the macOS Pod lock at the destination. |
| Prior monorepo Flutter migration | `9ef67a555c0f13ca2e88c4aecaf2c677fe6412fd` | Reused relative SDK wiring, unpublished package setup and CLI removal. Current source supersedes older page behavior; native runners are included. |
| `github.com/mattsp1290/ag-ui-go-server-example` | `ad756b7afd1c9abc4ebf422aaa28d338d154d2c3` | Existing monorepo import is retained for behavior-based reconciliation; source module replacements and provider migration are excluded. Detailed reconciliation follows with the Go contract slice. |

Both source checkouts remain intact. Source planning/IDE files, logs, generated SDK paths, caches, Pods and build products are excluded. The source sibling launcher and prior combined Go/Flutter launcher are intentionally retired. Native bundle/project identities remain unchanged.

## Verification status

The import resolves dependencies with Flutter 3.47.1 without the source `meta` override. Initial analysis reports 41 inherited diagnostics; the Flutter behavior slice owns those repairs without global suppression. The 22 imported Flutter tests and macOS debug build pass; Flutter migrated the macOS target to 12.0 and generated portable Swift Package Manager wiring. The parent Dart SDK passes 724 tests with 8 existing skips using `dart pub get --no-example`. Full contract, interactive platform and live-provider results are pending; this import alone does not establish end-to-end success.

## Run Codex text chat

Codex mode connects directly to the standalone Node server. It does not require the web Dojo. It supports Agentic Chat with text messages and conversation memory. Frontend tools, cards, approval callbacks, images, and shared-state writes are unavailable. The default Go endpoints remain unchanged.

In terminal 1, use Node 22 and the repository's pnpm version. Authenticate with the Codex CLI or set `CODEX_API_KEY` in this server terminal. Select a dedicated scratch Git repository as the agent workspace.

```bash
# From the repository root:
mkdir -p /tmp/ag-ui-codex-workspace
git -C /tmp/ag-ui-codex-workspace init
pnpm install
pnpm exec nx run @ag-ui/codex-sdk:build
CODEX_WORKING_DIRECTORY=/tmp/ag-ui-codex-workspace PORT=8032 pnpm exec nx run @ag-ui/codex-sdk:start
```

In terminal 2:

```bash
cd sdks/community/dart/example
flutter pub get
flutter run -d chrome --dart-define=AG_UI_BACKEND=codex --dart-define=AG_UI_BASE_URL=http://127.0.0.1:8032
```

Open Agentic Chat. Send `Hi, my name is Alex`, then `What is my name?`. Keep the same page open between turns. Provider credentials belong only in the server environment. The example uses a read-only sandbox with network access and web search disabled. Native progress may contain workspace content. Use a trusted local development host.

To verify the Flutter contract without a provider, run:

```bash
flutter test test/codex_backend_test.dart test/codex_chat_contract_test.dart
```

For a browser check against the real server and controlled CLI, start the server with explicit `CODEX_TEST_MODE=1` and `CODEX_PATH` pointing to `integrations/community/codex-sdk/typescript/examples/testing/codex-exec.mjs`. Set `CODEX_FIXTURE_DIR` to a fresh temporary directory. Launch Flutter with the same compile-time options above. Record the two visible replies and browser POST requests. The second request must retain the first thread ID and assistant message IDs, include the prior conversation, and send an empty tools list. Run the same two turns with the production executable and provider access separately. A controlled CLI check does not verify provider operation.
