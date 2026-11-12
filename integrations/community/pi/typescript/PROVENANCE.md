# Pi integration provenance

Adapted from YS-BW/pi-agui at commit `ee810dfb9ad3fe81d8854e9121b84ddee4c59148`. The source and npm archive include the original [MIT notice](LICENSE). [Donor revision](https://github.com/YS-BW/pi-agui/tree/ee810dfb9ad3fe81d8854e9121b84ddee4c59148)

| Donor path | Derived path | Adaptation |
| --- | --- | --- |
| `src/translate.ts` | `src/translate.ts` | Added caller-owned completion and IDs. Translate public text and committed tool calls, correlate native results and finish coding sessions on settlement. |
| `src/thread.ts` (`toAguiMessages`) | `src/messages.ts` | Project native entries using the IDs supplied by the host. Omit private reasoning and unsupported content. |
| `src/frontend-tools.ts` | `examples/client-tools.ts` | Register client tool definitions per request. End the turn at handoff and withhold Pi's internal placeholder result. |
| `examples/serve.ts`, `src/thread.ts` | `examples/server.ts` | Use a configurable provider, an in-memory session per request and the official encoder. Rebuild the conversation for tool continuations. |
| `src/input.ts` | `examples/conversation.ts` | Extract the new user prompt, restore text history, and correlate tool results with the preceding assistant calls. |
| `test/translate.test.ts` | `test/adapter.test.ts` | Adapt the text, tool, settlement and failure cases. Add a native Pi core loop and stable history checks. |
| `test/fixture.ts`, `test/integration.test.ts` | `test/example.test.ts` | Adapt the isolated coding-session fixture and official-client tests. Use Pi's controlled provider and assert the transcript and returned tool results across requests. |
| `LICENSE` | `LICENSE` | Original donor notice, copied in full. |

The donor manifest pinned Pi 1.3.0 and AG-UI 1.0.3. See the [package README](README.md) for the versions exercised by this integration.
