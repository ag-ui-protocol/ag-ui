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
  - Decided tokens are kept in process memory by default. **With more than one
    worker, pass a shared `ConsumedTokens` store** (for example Redis) as
    `consumed_tokens=` to `add_openai_agents_fastapi_endpoint` or
    `OpenAIAgentsAgent`. Otherwise a replay that reaches another worker, or
    comes after a restart, runs the tool again until the token expires. The
    server logs a warning at startup when
    `AG_UI_OPENAI_AGENTS_APPROVAL_SECRET` is set and the in-memory store is
    used.
  - An approval token expires after 15 minutes by default (`ttl_seconds`).
    This limits how long a replay can work when decided tokens are not shared.
    A token that expires while an earlier resumed tool runs is refused, not
    run again.
  - A token is bound to the agent that paused the call (`approval_scope=` on
    `OpenAIAgentsAgent`, default the agent's name; `ApprovalSigner(scope=...)`
    or `signer.scoped(...)` with the translator). Another agent with a tool of
    the same name refuses it, even with the same secret and store.
  - A signer without a scope neither issues nor verifies tokens. With the
    translator, pass a scoped signer as `approvals=` to both `to_agui` and
    `resume_tool_calls`; without one, `to_agui` ends a run that pauses for
    approval with `RUN_ERROR`, and every paused call resumes as `UNVERIFIED`.
  - A resumed call runs on the canonical JSON its token covers, so a duplicate
    key or an overflowing number cannot be read two ways. Argument text with a
    lone surrogate no longer crashes the signer.
  - `UNVERIFIED` and `ALREADY_ANSWERED` refusals are logged as warnings with
    the thread id, the call id and the tool name.
  - Reported privately by dtnvgs.

## 0.1.0

- First release.
