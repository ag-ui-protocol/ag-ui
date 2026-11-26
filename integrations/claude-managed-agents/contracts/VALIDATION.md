# PNI-692 implementation validation

Base: `b5562fd9c46482828e434fb67d3e33d5dc55f5db` (origin/main).
Branch: `fix/managed-shared-state`.

## Implemented

All three Managed adapters deliver state to native system context, register the
same reserved state-update tool, persist successful model updates as native tool
results, and emit committed AG-UI snapshots. Full replacement, RFC 7396 patch
(including null deletion and array replacement), explicit empty state, optimistic
revision checks and no-op behavior are defined in `shared-state-v1.md`.

Recovery derives state from native events rather than trusting a stale local
cache. Tests cover cold binding reconstruction, native-only imports, existing
catalog preservation, conflicting reserved names, original pending state-tool
IDs, failed delivery, explicit successful-result markers, primary/child ownership,
empty-state behavior and pending approvals. Catalog changes append only the
reserved tool at a safe user-turn boundary. Child cross-posts do not write root
state or receive root-owned answers.

Native request shape is checked against the installed SDK contract: at most one
system.message per request, final and adjacent to a supported user/tool-result
companion. Runtime context and state occupy separate text blocks in that event.
Multiple state-prefixed blocks are rejected as ambiguous.

## Versions and commands

| Implementation | Adapter source version | Native dependency used                 | Verification                     |
| -------------- | ---------------------- | -------------------------------------- | -------------------------------- |
| TypeScript     | 0.0.4                  | `@anthropic-ai/sdk` 0.113.0            | 220 tests; typecheck; Nx build   |
| Python         | 0.2.2                  | `anthropic` 0.119.0                    | 241 tests; Ruff                  |
| .NET           | 0.0.4                  | Anthropic 12.37.0 / assembly 12.37.0.0 | 238 tests; net8/net9/net10 build |

TypeScript loads the native SDK from
`/Users/ran/Desktop/ag-ui/node_modules/.pnpm/@anthropic-ai+sdk@0.113.0_zod@3.25.76/node_modules/@anthropic-ai/sdk`.
AG-UI core/client 1.0.3 are built from this isolated worktree, not stale installed
artifacts. Node is 24.21.0. Python loads the native SDK from
`/private/tmp/pni681-venv/lib/python3.12/site-packages/anthropic`, with current
worktree `sdks/python` via PYTHONPATH (AG-UI 1.0.0), Python 3.12, pytest 9.1.1 and
httpx 0.28.1. .NET SDK 10.0.201/runtime 10.0.5 loads Anthropic 12.37.0.

Run from the repository root:

```sh
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run @ag-ui/claude-managed-agents:build --parallel=1
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run @ag-ui/claude-managed-agents:typecheck --excludeTaskDependencies --parallel=1
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run @ag-ui/claude-managed-agents:test --excludeTaskDependencies --parallel=1 -- --maxWorkers=1
```

Run Python from `integrations/claude-managed-agents/python` with its environment:

```sh
PYTHONPATH=.:../../../sdks/python /tmp/pni681-venv/bin/python -m pytest -q --disable-warnings
```

.NET has no Nx project; run from its integration folder:

```sh
dotnet test tests/AGUI.ClaudeManagedAgents.Tests/AGUI.ClaudeManagedAgents.Tests.csproj -m:1 --no-restore --logger 'console;verbosity=minimal'
dotnet build src/AGUI.ClaudeManagedAgents/AGUI.ClaudeManagedAgents.csproj -m:1 --no-restore
```
 The multi-target build reports existing NU1902 warnings from the Git build
task dependency; it has zero compilation errors.

## Regression and native evidence

- The same TS localhost/native-SDK subprocess regression was run against unchanged
  main and failed because the native feed contained no state; it passes with this
  implementation, including a second fresh adapter process importing and
  continuing the same native session. Original user prompt contains no unique
  state value; the deterministic provider derives its update from native state.
- Python runs its actual installed SDK in a subprocess against a deterministic
  localhost server and verifies native state delivery, patch and successful result.
- .NET exercises its actual installed SDK through a deterministic HTTP handler
  and validates the same native request constraints and result shape. Cold binding
  recovery and approvals are also covered by adapter regression tests.
- `typescript-state-events.json`, `python-state-events.json` and
  `dotnet-state-events.json` are captured deterministic native-shaped fixtures,
  not real Anthropic provider captures. They include primary scope and timestamps.
- The PNI-694 owner tested these producer fixtures through the Intelligence loader,
  migrated database, restore plan and current state. Repeat import preserves
  continued history, replacement rejects active/continued destinations, and source
  fixture bytes stay unchanged. That consumer is a separate required PR.
- Saved real-provider failing-before evidence for all three languages remains in
  the October 21 campaign report and named state-probe captures. No baseline files
  were modified.

## Integration and remaining acceptance

Install/build this branch's three adapters and the PNI-694 Intelligence consumer
PR together: [Intelligence #1972](https://github.com/CopilotKit/Intelligence/pull/1972), tested consumer head `b9e99b8825b95313c38c37feea9fbb5b62b7c862`. Keep the application's authorized `resolveSession` binding and durable
session store. Imported native catalogs are preserved; unrelated new frontend tools
are deliberately not added. Do not backfill legacy histories lacking state records.

This PR does not certify PNI-646's full five-implementation/six-row matrix. Real
paid-model reads/writes, browser refresh and UI behavior, cold provider restart,
and combined charts/A2UI/MCP/attachments/parallel approvals must be run by the
coordinator on the final combined PR heads and intended published versions.
Reasoning/media source limitations and SDK child/parallel recovery belong to the
parent and other tickets. No unsupported path is counted as passing.

No paid provider calls, merges, releases, Linear Done changes or green-table claims
were made. The campaign reservation remains $37.40 of the existing $40 cap.
