# Changelog

## 1.0.4 — 2026-11-05

- `zod` moved from a direct dependency to a required peer dependency (`^3.25.18 || ^4.0.0`) so the application's zod is used.

### Breaking changes

- `zod` must now be installed by the consuming application as a peer dependency (`^3.25.18 || ^4.0.0`).

## 1.0.3 — 2026-10-15

- Maintenance release; no consumer-facing changes identified.

### Breaking changes

None.

## 1.0.2 — 2026-10-05

- Maintenance release; no consumer-facing changes identified.

### Breaking changes

None.

## 1.0.1 — 2026-09-29

- Maintenance release; no consumer-facing changes identified.

### Breaking changes

None.

## 1.0.0 — 2026-09-17

- Updated for the 1.0 release with generated models and protobuf wire support.
- Protocol version emitted is now "1.0", naming the 1.0 schema address.

### Breaking changes

- Protocol version changed to "1.0"; the schema $id address moved to /spec/1.0/schema.json.
