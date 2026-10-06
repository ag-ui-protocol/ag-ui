# Strands SDK floors and AG-UI 1.0

PNI-562 follows the merged [AG-UI 1.0 migration PR #2894](https://github.com/ag-ui-protocol/ag-ui/pull/2894).
Both adapters already declare `protocolVersion` on `RUN_STARTED`; Python requires
`ag-ui-protocol>=1.0.0`, and TypeScript requires core/client >=1.0.0 for `/schemas`.
The two Dojo lanes assert the version on the wire. This follow-up retains that work.

## Python: 1.55.0

[Strands 1.55.0](https://strandsagents.com/changelog/sdk/python-v1.55.0/)
provides `pending_tool_execution`, `set_pending_tool_results`, and
`_InterruptState.from_dict` migration of old serialized tool batches.
`SnapshotSessionManager` arrived in 1.51, but 1.55 also closes the inner run
loop when a halted frontend stream closes, allowing its snapshot to be saved
before `RUN_FINISHED`. Therefore 1.51 alone is insufficient for reliable
immediate restart. The installed 1.55.0 source and real session tests verify
these APIs; the adapter no longer reads the pre-1.55 live layout or catches an
ImportError for pre-snapshot SDKs.

Saved data is still supported: restore through the SDK session manager with
the same session/agent IDs and storage. Repository sessions remain supported;
there is no requirement to convert them into snapshots. The SDK migrates old
checkpoint keys during restore. Adapter migrations for stored interrupt answers
remain in place. Custom stores must restore via the SDK deserializer rather
than inject an obsolete live object.

## TypeScript: 1.1.0 (unchanged)

[The 1.1.0 release](https://github.com/strands-agents/sdk-typescript/releases/tag/v1.1.0)
introduced `AfterToolsEvent.endTurn` (#982), which the adapter uses to stop a
frontend-tool turn. Its published types also provide `SessionManager.saveSnapshot`
and the interrupt snapshot surfaces used by reconciliation. These concrete APIs
justify retaining 1.1.0 independently of the Python floor. CI now tests the
manifest-declared floor and latest release explicitly, in addition to the lockfile.

The AG-UI 1.0 schema rejects retired `binary` inputs. The converter no longer
accepts them when called without validation: they are reported as unknown input.
Use typed media (`image`, `document`, `video`) with a `source`; use
`metadata.filename` for a display filename. Native SDK snapshot data is unaffected.

## Validation and release handoff

Focused coverage includes repository and snapshot restore of a pre-1.55 tool
batch, a pending frontend answer, completed backend work, and another restart
with an identical resume. The backend side-effect counter remains one.
The full adapter suites are exercised at Python 1.55.0/current and TypeScript
1.1.0/current; exact run results are recorded in the follow-up PR.

Package publication and optional deprecation remain in PNI-548. CopilotKit
adoption remains in PNI-551. This work does not merge or publish packages.
