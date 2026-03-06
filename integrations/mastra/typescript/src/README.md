
## Bug Fixes

| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 1 | Perf | `utils.ts` | `tool` message toolName lookup is O(n²) | `buildToolNameIndex()` builds a `Map` in one pass, O(1) lookup |
| 2 | Data loss | `utils.ts` | `binary` content (images/files) silently dropped | `toMastraUserContent()` maps `binary` → `ImagePart / FilePart` |
| 3 | Data loss | `utils.ts` | `system` / `developer` role messages not handled, lost | Added branches in switch-case |
| 4 | **Critical** | `mastra.ts` | `agent.stream()` called without `abortSignal`, stream cannot be cancelled, resource leak | Pass `ctrl.signal` |
| 5 | **Critical** | `registry.ts` | `step-start` chunk's server-assigned `messageId` not synced, client/server IDs diverge | `step-start` handler calls `ctx.syncMessageId(payload.messageId)` |
| 6 | Hang risk | `registry.ts` | `abort` chunk ignored, loop may hang | `abort` handler calls `ctx.markAborted()` |
| 7 | Resource leak | `mastra.ts` | No `finally` on `for await`, `onRunFinished` not guaranteed, Observable may never complete | Wrap stream iteration in `try/finally` |
| 8 | Resource leak | `mastra.ts` | Remote agent path also missing abort handling | `abortSignal.addEventListener("abort", ...)` drives `ctx.markAborted()` |
| 9 | **Critical** | `mastra.ts` | Observable teardown is `() => {}`, unsubscribe cannot stop the underlying stream | Teardown returns `() => ctrl.abort()` |
| 10 | Error throw | `mastra.ts` | Calling `next/error/complete` after subscriber closes throws | `emit/fail` wrappers guard with `!subscriber.closed` |
| 11 | State error | `registry.ts` | `messageId` reset on `finish`, but next step needs a fresh ID | `finish` handler calls `ctx.rotateMessageId()` |
| 12 | Crash risk | `mastra.ts` | `agent.name!` non-null assertion, `name` may be `undefined` | Use `agentId` from function parameter instead |
| 13 | Duplicate history | `utils.ts` | Message IDs not preserved, Mastra cannot deduplicate, causing duplicate history insertions | Return `MastraMessageV1[]`, preserve original `message.id` |

---

## Extension Points

### 1. Inject a Custom Registry

The most common extension: append or override chunk handlers on top of the default registry.

```ts
import { createDefaultRegistry, MastraAgentAdapter } from '@ag-ui/mastra';

// Option A: function form (recommended)
const agent = new MastraAgentAdapter(config, {
  registry: (defaultRegistry) =>
    defaultRegistry
      .register('tool-result', (chunk, ctx) => {
        // append custom tool-result logic
        console.log('tool result:', chunk.payload);
      }, 'append')
      .register('text-delta', (chunk, ctx) => {
        // fully replace default text-delta handling
        ctx.emit({ /* custom event */ });
      }, 'replace'),
});

// Option B: pass a registry instance directly
const registry = createDefaultRegistry()
  .register('step-start', (chunk, ctx) => {
    console.log('step started:', chunk);
  }, 'append');

const agent = new MastraAgentAdapter(config, { registry });
```

### 2. Register Modes (`RegisterMode`)

| Mode | Behavior |
|------|----------|
| `'replace'` (default) | Replaces all existing handlers for that chunk type |
| `'append'` | Appends after existing handlers, executed in registration order |
| `'skip'` | No-op if a handler already exists |

### 3. Handler Error Strategy (`HandlerErrorMode`)

```ts
// fail-fast (default): a throwing handler immediately aborts the stream
const agent = new MastraAgentAdapter(config, {
  registryErrorMode: 'fail-fast',
});

// continue: log the error and keep dispatching to remaining handlers
const agent = new MastraAgentAdapter(config, {
  registryErrorMode: 'continue',
});
```

### 4. Inject a Custom Logger

```ts
import type { AgentLogger } from '@ag-ui/mastra';

const myLogger: AgentLogger = {
  debug: (event, payload) => { /* forward to OpenTelemetry */ },
  info:  (event, payload) => { /* write to log service */ },
  warn:  (event, payload) => { /* alert */ },
  error: (event, payload) => { /* error reporting */ },
};

const agent = new MastraAgentAdapter(config, { logger: myLogger });
```

> `logger` takes priority over the `debug` flag.

---

## Usage

### Enable Debug Logging

```ts
// Option A: debug flag (uses built-in logger)
const agent = new MastraAgentAdapter(config, { debug: true });

// Option B: via factory options
MastraAgentAdapter.getLocalAgents({
  mastra,
  resourceId: 'user-123',
  debug: true,
});
```

> The built-in logger redacts sensitive fields (`messages`, `content`, `args`, `result`) and only outputs metadata such as `threadId`, `runId`, and `chunkType`.

### Reuse Config with `clone()`

```ts
const base = new MastraAgentAdapter(config, { debug: true });

// clone preserves config + registry (deep copy) + logger
const copy = base.clone();
```

---

## File Structure

```
mastra-agui/
  types.ts      ← all type definitions (StreamRunContext, ChunkHandler, config interfaces, etc.)
  registry.ts   ← ChunkHandlerRegistry class + createDefaultRegistry() factory
  logger.ts     ← AgentLogger interface + createAgentLogger() factory
  utils.ts      ← message conversion utilities (convertAGUIMessagesToMastra, etc.)
  mastra.ts     ← MastraAgentAdapter class (lifecycle + abort management only)
  copilotkit.ts ← registerCopilotKit() route registration
  index.ts      ← re-exports all public symbols
```
