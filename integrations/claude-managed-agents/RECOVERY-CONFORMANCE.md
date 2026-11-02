# Recovery conformance

Use these scenarios when changing recovery in any of the TypeScript, Python,
or .NET adapters. A passing synthetic scenario does not establish live-provider
or imported-conversation product validation.

| Scenario                                          | Required behavior                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout or client cancellation during reconnect   | For both adopted and adapter-created sessions, disconnect the local stream without sending a native interrupt. Pending requests remain answerable on the next run.                                                   |
| Result submitted before a buffered idle event     | Put a custom call or approval in history and its `requires_action` event only in the live stream. Submit the answer once; ignore the late idle for that answered ID and continue through the response to `end_turn`. |
| Answer already present in history                 | Carry its ID into the live consumer so a late `requires_action` does not fail as an unsupported action.                                                                                                              |
| Live permission request while another thread runs | Emit an approval interrupt as soon as a built-in or MCP `ask` call arrives, without requiring session-level idle. Persist and resume it after restart with the original call and child-thread IDs.                   |
| Partially displayed text                          | With `hello` already displayed and `hello world` in history under the same message ID, emit only ` world`.                                                                                                           |
| Fully displayed text                              | Emit no duplicate content when the existing message equals the history text.                                                                                                                                         |
| Conflicting displayed text                        | Report `history_content_conflict` instead of appending incompatible content. Do not advance the durable cursor past the failed replay.                                                                               |
| Restart after replay                              | Persist the successful cursor and reconnect with the updated transcript. Do not emit the suffix again or leave a partial message truncated.                                                                          |

The port-specific recovery suites are:

- [TypeScript](typescript/src/__tests__/recovery.test.ts)
- [Python](python/tests/test_recovery.py)
- [.NET](dotnet/tests/AGUI.ClaudeManagedAgents.Tests/ManagedAgentsRecoveryTest.cs)
- [.NET review regressions](dotnet/tests/AGUI.ClaudeManagedAgents.Tests/ManagedAgentsRecoveryReviewTest.cs)

Also run each port's turn and agent suites. The Dojo fake-provider browser lanes
exercise continued chat, tool results, and approvals across all three ports;
the shared fake's SDK tests additionally check native history pagination.
