# Changelog

## Unreleased

### Security

- Resuming a tool approval now runs only a tool call that this server paused.
  Before, a client could add a tool call to its own history (any function tool
  of the agent, with any arguments) and approve it in a `resume` entry, and the
  server ran it before any model call. It could also change the arguments of a
  paused call, or send the same approval again to run a call twice.
  - The server signs each paused call with an HMAC over the thread, call id,
    tool name and canonical arguments. The token rides on the call in the
    `MESSAGES_SNAPSHOT` (`ToolCall.metadata["ag-ui"]["heldCall"]`).
  - A resume entry for a call without a valid token gives `UNVERIFIED` and the
    tool does not run. An undecided call without a valid token is not asked
    again; it gets `ABANDONED`.
  - Each token is used once. Deciding the same call again gives
    `ALREADY_ANSWERED`, and a result the server wrote is never replaced.
  - New: `ApprovalSigner`, `ConsumedTokens`, `default_approval_signer()`, and
    the `approvals=` argument of `OpenAIAgentsAgent`, `resume_tool_calls` and
    `AGUITranslator.to_agui`. Set `AG_UI_OPENAI_AGENTS_APPROVAL_SECRET` (at
    least 32 bytes), or pass a signer, so that all workers share one secret.
  - Reported privately by dtnvgs.

## 0.1.0

- First release.
