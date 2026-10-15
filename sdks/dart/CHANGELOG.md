# Changelog

## 1.0.0-dev.1

The first cut of the first-party Dart client, as a skeleton to be completed.

- Protocol types generated from `spec/1.0/schema.json`: immutable classes
  with `fromJson`/`toJson`, sealed unions, enums with wire names, and a shape
  table for enforcement.
- `HttpAgent` over server-sent events, with an injectable `http.Client`.
- The run pipeline ported from the TypeScript client: era shims for 0.0.39,
  0.0.45 and 0.0.57 peers, the compatibility boundary, enforcement, chunk
  expansion, verification and event application onto `messages` and `state`.
- The shared conformance corpus running as a third lane.
