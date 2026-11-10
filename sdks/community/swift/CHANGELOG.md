# Changelog

## Unreleased

- Reconcile the protocol 1.0 additions with the merged upstream Swift SDK,
  preserving all four libraries and subsequent HTTP/SSE fixes.
- Add lossless JSON, schema fixtures, stream conformance, and the dojo example.
- Support canonical media `source` objects, including URL, inline data, and
  provider file handles. Legacy constructors remain available.
- Preserve scalar run results, optional text-message roles, thread history,
  and state; bound JSON nesting and make SSE framing linear-time.
- Propagate cancellation, fix tool-call replay/parent/result ordering, and
  restore the full client test suite. See [DERIVATION.md](DERIVATION.md).
