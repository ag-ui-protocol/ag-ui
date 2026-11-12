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
