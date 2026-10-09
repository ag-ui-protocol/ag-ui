# Strands framework SDK compatibility

PNI-562 is framework compatibility cleanup on top of Markus Ecker's merged
[AG-UI 1.0 adoption #2894](https://github.com/ag-ui-protocol/ag-ui/pull/2894)
and [Strands aux_model fix #2970](https://github.com/ag-ui-protocol/ag-ui/pull/2970).
Protocol declarations, AG-UI dependency floors, schemas, and content conversion
remain outside this follow-up's scope.

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

The former [1.15.0 floor](https://strandsagents.com/changelog/sdk/python-v1.15.0/)
was released November 4, 2025; [1.51.0](https://strandsagents.com/changelog/sdk/python-v1.51.0/)
on August 7, 2026; 1.55.0 on September 8, 2026. As assessed October 7,
1.55 is only 29 days old. This is an API and persistence correctness exception,
not a claim that it is widely adopted or an age-based retirement requirement.
No version-specific adoption evidence was established. Staying at 1.51 would
retain the halted-snapshot race; retaining 1.15 would also retain separate live
checkpoint layouts and the optional snapshot import. The tradeoff is requiring
users pinned below 1.55 to upgrade their framework and resolve its dependencies.
This remains within Python SDK major version 1; provider-specific errors and
configuration still require application validation after an SDK upgrade.

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
justify retaining 1.1.0 independently of the Python floor. Released May 8, 2026,
1.1.0 is about five months old at this assessment. No additional TypeScript
framework-floor increase is justified by the APIs used here. TypeScript 1.0.0
was published April 30, 2026, less than six months before this assessment.
Registry checks found Python 1.58.1 and TypeScript 1.19.0 as the latest releases;
being latest alone is not a reason to raise either floor. CI now tests the
manifest-declared floor and latest release explicitly, in addition to the lockfile.

## Validation and release handoff

Focused coverage includes repository and snapshot restore of a pre-1.55 tool
batch, a pending frontend answer, completed backend work, and another restart
with an identical resume. The backend side-effect counter remains one.
The full adapter suites are exercised at Python 1.55.0/current and TypeScript
1.1.0/current; exact run results are recorded in the follow-up PR.

Package publication and optional deprecation remain in PNI-548. CopilotKit
adoption remains in PNI-551. This work does not merge or publish packages.
