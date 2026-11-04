# Changelog

## 0.0.1 — 2026-11-02

- Initial release: connects AG-UI to the OpenAI Agents API (`client.beta.agents.sessions`).
- One session per AG-UI thread; text, reasoning summaries and hosted tool activity stream as AG-UI events.
- Frontend tools are installed on the session and kept in sync (`sessions.update`); the run parks on their calls and the next run forwards the client's results into the same turn.
- Backend tools run on the server, with `requiresApproval` and `context.interrupt()` surfaced as AG-UI interrupts (`RUN_FINISHED.outcome.type = "interrupt"`) and resumed from `RunAgentInput.resume`.
- Context entries and shared state are sent with each user message; `predictState` publishes tool arguments as predicted state.
- Native computer-use approval requests are surfaced as interrupts.
