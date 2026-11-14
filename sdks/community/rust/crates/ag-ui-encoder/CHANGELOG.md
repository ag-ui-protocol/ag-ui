# Changelog

## 0.2.0 (unreleased)

Initial framework-independent AG-UI 1.0 JSON/SSE encoder release, sharing the
core 0.2.0 model. Rust 1.88 is required.

Provides strict producer validation, canonical JSON and SSE encoding, and live
run framing. Optional fields are omitted rather than emitted as null; required
null snapshots and opaque application JSON remain intact. Upgrade core and
encoder together and validate outgoing events before sending bytes.

Crates have not been published. Git delivery uses a qualified upstream commit;
CI verifies workspace packaging separately from publication.
