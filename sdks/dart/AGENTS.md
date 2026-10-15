# AG-UI Dart SDK — working notes

This is the first-party Dart client for AG-UI, protocol version 1.0, package
`agui`, version `1.0.0-dev.1`. It is a V0: a working skeleton, generated from
the protocol schema, with the whole TypeScript run pipeline ported and the
shared conformance corpus running — and a deliberate list of things not done,
at the end of this file. The community package at `sdks/community/dart`
(`ag_ui` on pub.dev) is a separate, older implementation; nothing here
touches it, and it is not a dependency.

The TypeScript client at `sdks/typescript/packages/client` is the reference
implementation. When this file says "as TS does", that is where to look.

## Layout

```
lib/agui.dart                 the barrel: everything public
lib/src/generated/            GENERATOR-OWNED — never edit, regenerate
  models.dart                 every protocol definition: enums, typedefs,
                              mixin interfaces, sealed unions, final classes
                              with fromJson/toJson
  shapes.dart                 the model as Dart data, for the stripper
  version.dart                protocolVersion, from the schema's $id
lib/src/errors.dart           the exception hierarchy
lib/src/codec/                omitOptionalNulls: the producer-side null contract
lib/src/sse/                  the server-sent events parser
lib/src/client/               AbstractAgent, HttpAgent, ids, warnings
lib/src/pipeline/             the run pipeline, one file per stage
example/agui_example.dart     one turn against a running agent
test/                         see "Tests"
```

The pipeline, in the order `run_pipeline.dart` runs it on inbound events
(outgoing, only the era shims touch the request, 0.0.57 before 0.0.39), with
the TypeScript file each stage was ported from:

| Dart | TypeScript | What it does |
| --- | --- | --- |
| `pipeline/compat/boundary.dart` (+ `optional_nulls.dart`, `legacy_content.dart`, `thinking.dart`) | `middleware/compatibility-boundary.ts`, `legacy-content.ts`, `compat-warning.ts` | always-on and innermost: tabled optional nulls read as absent, THINKING_* translated, legacy binary parts upgraded |
| `pipeline/era/era_0_0_39.dart`, `era_0_0_45.dart`, `era_0_0_57.dart`, `era/select.dart` | `middleware/backward-compatibility-0-0-*.ts` and the auto-insert in `agent/agent.ts` | downgrades for peers pinned below 1.0, as plain functions selected by `maxProtocolVersion` (0.0.45 then 0.0.57 inbound) |
| `pipeline/enforce.dart` (+ `strip.dart`) | `enforce/enforce.ts`, `enforce/strip.ts` | unknown event types dropped, unknown material stripped with a warning per path, then decoded; a malformed known field is fatal |
| `pipeline/chunks.dart` | `chunks/transform.ts` | `*_CHUNK` events expanded into start/content/end triads |
| `pipeline/verify.dart` | `verify/verify.ts` | the lifecycle and attribution rules |
| `pipeline/apply.dart` (+ `json_patch.dart`, `producer_version.dart`) | `apply/default.ts`, `agent/agent.ts` (`warnOnProducerDeclaration`) | every event applied onto `messages`, `state` and `pendingInterrupts` |

Raw events (`Map<String, Object?>`) flow through the shims, the boundary and
enforcement; typed `Event`s flow from enforcement onward.

## Commands

All from `sdks/dart`. CI (`.github/workflows/unit-dart.yml`) runs exactly
these, with the Dart SDK pinned to `3.13.5` — pinned, not `stable`, because
the generator emits already-formatted Dart and the format check only means
something against one formatter version.

```bash
dart pub get
dart analyze --fatal-infos
dart format --set-exit-if-changed .
dart test
dart test test/conformance          # the corpus lane alone
dart run example/agui_example.dart http://localhost:8000/agentic_chat
```

To change anything under `lib/src/generated`, change the schema or the
emitter and regenerate:

```bash
pnpm --filter @ag-ui/spec generate    # emitter: spec/generator/dart.ts
pnpm --filter @ag-ui/spec test        # the drift gate: committed bytes must equal emitted bytes
```

The emitter lays code out the way `dart format` 3.13 does (a small layout
helper in `dart.ts`); if the Dart CI format check ever disagrees, fix the
emitter, never the output.

## Design rules

- **Generated types are immutable.** `final` fields, named constructor
  parameters, no `copyWith`, no `==`. Code that changes a message builds a
  new one (see the `_with…` helpers in `apply.dart`).
- **The codec is strict, the boundary is tolerant.** `fromJson` ignores
  unknown keys, rejects `null` on an optional field, and throws
  `AguiDecodeException` on a missing required field, a wrong type, an unknown
  enum value or an unknown discriminator — the same contract as the generated
  zod schemas. Everything the protocol tolerates (the optional-null table,
  retired shapes) is converted by the compatibility boundary before decoding,
  with a warning. The RFC 6902 operations are open and keep undefined members
  in `extras`.
- **Serialization omits valueless optionals.** `toJson` never writes `null`
  for an optional field; required nulls (`CUSTOM.value`) are written.
  `omitOptionalNulls` applies the same rule to raw documents.
- **Warnings go to `onWarning`; failures are stream errors.** There is no
  console output anywhere in `lib/`. `AguiProtocolException` for a lifecycle
  or streaming violation, `AguiDecodeException` for a malformed event or a
  frame that is not JSON, `AguiHttpException` for a non-2xx response,
  `AguiStateException` for misuse. A failed connection surfaces as the
  `http` package's own `ClientException`. Several warning texts end with
  "Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence" because they are
  shared with TypeScript and the corpus matches them; Dart reads no
  environment variable, and `onWarning` is the only way to silence them.
- **Error and warning text is shared with TypeScript.** The conformance
  corpus asserts substrings of them (`errorContains`, `warnings`). Change a
  message in both clients or in neither.
- **One run at a time.** `run()` throws `AguiStateException` while a run is
  active (the TypeScript client does not throw; this is a deliberate
  tightening). The run starts on listen, cancelling the subscription ends
  it, and a stream never listened to starts nothing. Events are yielded after
  they are applied, so `agent.messages` and `agent.state` are current when a
  listener sees one. `agent.messages` is a fresh read-only view after every
  applied event (new identity, no outside mutation), not a deep copy as in
  TypeScript, so a reference held across events sees later changes.
- **`maxProtocolVersion` must be a dotted numeric version** (`^\d+(\.\d+)*$`);
  anything else is an `ArgumentError` at construction, as TypeScript throws
  for a ceiling it cannot compare.
- **`HttpAgent.close()`** closes the client the agent created (an injected
  one is the caller's); without it an idle keep-alive socket keeps the VM
  alive for several seconds after the last run.
- **The peer ceiling is a constructor parameter.** `maxProtocolVersion`
  below 1.0 installs the era shims and leaves `protocolVersion` off the
  request.
- **No per-event scans in the reducer.** `apply.dart` keeps id→index maps,
  as TS does.
- **Pure Dart.** `package:http` is the only runtime dependency. Nothing in
  `lib/` imports `dart:io`.

## Tests

| Directory | Reads | Proves |
| --- | --- | --- |
| `test/generated/` | `spec/1.0/fixtures` (135 valid, 84 invalid documents) | the codec accepts and round-trips every valid document and rejects every invalid one (except `unevaluatedProperties` cases, which the codec ignores by design) |
| `test/fixtures/` | `sdks/fixtures/null-omission.json`, `agent-capabilities.json` | the cross-language serialization contracts; Dart is in their `producedBy` |
| `test/conformance/` | `spec/1.0/conformance/streams` | every stream replayed as SSE bytes through a mock `http.Client` into `HttpAgent` and held to the fixture's expectation — the primary test of the client |
| `test/pipeline/` | — | one file per stage |
| `test/client/`, `test/sse/` | — | transport and lifecycle |

The fixture corpora are read by path from the repository, so a schema change
fails these tests in the same PR. `spec/harness/conformance.test.ts` knows
the `dart` lane; an `expectOverrides.dart` block needs an `intentional`
reason and is listed below.

## Conformance overrides

Every place this lane deliberately differs from the base expectation. Keep
this list equal to `grep -l '"dart"' spec/1.0/conformance/streams/*.json`.

- `reasoning-message-wrong-role-fatal` — the rule holds (a wrong role is
  fatal); only the rejection text differs: zod's escaped spelling versus the
  Dart decoder's `expected "reasoning", received "assistant"`.

Two fixtures that need no override but are worth knowing about:
`era-0-0-47-upgrades-binary-content` and `era-current-peer-keeps-modern-content`
feed a retired `binary` part as input. The Dart input is typed, so the lane
decodes fixture input through `decodeLegacyMessage`, the client's own entry
point for pre-1.0 message documents, which is where that upgrade lives in Dart
(TypeScript upgrades its loosely typed input on the way out instead).

## Not implemented

In priority order. Each names its TypeScript counterpart.

1. **Subscriber API and mutations** — `agent/subscriber.ts`, the
   `runSubscribersWithMutation` calls throughout `apply/default.ts`. The
   reasoning-span, subagent and step branches of `apply.dart` are no-ops for
   this reason. Design it around Dart idioms (`ChangeNotifier`, streams)
   rather than porting the hook interface one to one.
2. **Middleware abstraction** — `middleware/middleware.ts`,
   `filter-tool-calls.ts`. The era shims in `pipeline/era/` are plain
   functions today; a middleware layer should wrap them, not replace them.
3. **Resume validation and interrupt expiry** — `interrupts/`,
   `AbstractAgent.onInitialize` in `agent/agent.ts`. `pendingInterrupts` is
   recorded, never checked against a run's `resume` entries.
4. **Protobuf transport** — `@ag-ui/proto` and `spec/generator/protobuf.ts`
   (the .NET emitter shows what a second wire format costs).
5. **Legacy event conversion, compaction, activity history** — `legacy/`,
   `compact/`, `activity-history.ts`.
6. **`copyWith`, equality, `toString` on generated types** — an emitter
   change in `spec/generator/dart.ts`; `copyWith` on optional fields needs a
   sentinel pattern, which is a design decision.
7. **Strip-and-warn for unknown enum values** — the admitted gap pinned by
   `unknown-enum-value-role-fatal`; today an unknown member is fatal, as in
   TypeScript.
8. **`docs/sdk/dart`** — the pages there describe the community package and
   are not in `docs/docs.json`; this package has only its README.
9. **pub.dev publishing** under the name `agui` (`publish_to: none` today).
10. **Flutter companion package** — widgets and stream helpers belong beside
    this package, not in it.
11. **Streaming performance of text deltas** — messages are rebuilt per
    delta (immutable types), which is quadratic in a message's length;
    a builder during streaming would fix it.
12. **The rest of the agent surface** — `connectAgent` (note the naming
    clash: Dart's `connect` is the transport, what TypeScript calls
    `run(input)`; TypeScript's `connect` is the reconnect path), `abortRun`
    and `detachActiveRun` (today: cancel the subscription), `clone`,
    `addMessage(s)`, `setMessages`, `setState`, `getCapabilities`.
13. **A drift guard for the optional-null table** — `optional_nulls.dart` is
    a hand copy of the TypeScript table; nothing keeps the two in sync. The
    conformance corpus catches a divergence only where a fixture exercises
    the field.
14. **A copy guard for the generated types** — the reducer's copy helpers
    (`withContent` and friends in `apply.dart`) are hand-written per message
    class; `test/pipeline/apply_helpers_test.dart` builds every class with
    every field set and would catch a new field being dropped, but only once
    someone adds the new field to that test. Emitting `copyWith` (item 6)
    removes the hazard.
