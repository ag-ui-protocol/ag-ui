# Changelog

## 1.0.0 — 2026-09-17

- Client now declares the protocol version it speaks: every `RunAgentInput` carries "1.0", read from the generated `AGUIProtocol.Version`.
- Client validates the producer's protocol version, mirroring the TypeScript client handshake.
- Moved onto the generated 1.0 models.

### Breaking changes

- The protocol version is the generated `AGUI.Abstractions.AGUIProtocol.Version`; there is no hand-written constant beside it.
- Wire protocol version now sent as "1.0"; model names and null handling follow the 1.0 schema.
