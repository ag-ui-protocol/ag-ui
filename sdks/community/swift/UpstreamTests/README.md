# Deferred upstream client tests

These 14 files preserve 247 test methods from PR #1512. SwiftPM only compiles
the focused client tests in `Tests/AGUIClientTests` for this first package slice.
The retained gate covers wire-shaped decoding, immediate buffered yields,
URLSession cancellation during an active byte stream, and an environment-gated
dojo run. The full upstream core test suite remains compiled.

On Xcode 26.2 / Swift 6.2.3, the full imported client suite repeatedly stopped
making progress inside XCTest's async waiter after roughly 100 client cases.
Core tests and the focused client classes pass in isolation. Omitting only
`BufferingTests` and `AgentSubscriberTests` did not resolve the stall; omitting
`ChunkTransformTests` moved it later into `EventStreamTests`. No assertion
failure was reported. Restore these files to `Tests/AGUIClientTests` after the
interacting async test work is isolated and repaired.
