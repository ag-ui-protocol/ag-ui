# Source derivation

The protocol 1.0 work initially reused `AGUICore`, `AGUIClient`, and their tests
from ag-ui-protocol/ag-ui pull request #1512 at
`84c7fbfc51d5c0295ffc0561636f11b7ff70a422`.

After #1512 landed as `0cd0f10fe8267df6fb624112c886a0acd7ab8acc`, this branch
was reconciled with upstream main at
`ecc6ba16d3e6384d4fb248a1b6ceb735ef8b1fb9`. The merged SDK's four library
products (`AGUICore`, `AGUIClient`, `AGUIAgentSDK`, and `AGUITools`), examples,
MIT license, and source headers are retained, along with subsequent SSE
response validation and mid-stream URLSession error mapping fixes.

Local additions include the lossless JSON/schema definitions, protocol 1.0
fixture and stream conformance lanes, review regressions, and the
`agui-dojo-chat` executable. Client tests previously parked in `UpstreamTests`
are restored to `Tests/AGUIClientTests`. Pipeline fixtures use in-memory HTTP
responses; dedicated transport tests continue to exercise URLSession.
