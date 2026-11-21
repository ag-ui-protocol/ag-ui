# @ag-ui/omnara

Connect an [AG-UI](https://ag-ui.com) frontend, such as [CopilotKit](https://copilotkit.ai), to [Omnara](https://omnara.com), the open-source control plane for durable, hosted agents. Each chat thread gets its own Omnara agent, per user, launched from a [profile or an inline definition](https://docs.omnara.com/agents/configuration).

## Installation

```bash
npm install @ag-ui/omnara
```

Requires Node 22.12+ (the CommonJS build loads the ESM-only `@omnara/sdk`).

## Usage

```typescript
import { OmnaraAgent } from "@ag-ui/omnara";

const agent = new OmnaraAgent({
  apiKey: process.env.OMNARA_API_KEY, // org API key, developer role on the project
  orgId: "org_...",
  projectId: "proj_...",
  profile: "support-agent", // or `definition: { source }`
  user: { id: session.userId, name: session.userName }, // from your auth, per request
});
```

With CopilotKit, build the agent in the runtime's `agents` factory, which receives the request, so `user` comes from your own auth:

```typescript
new CopilotRuntime({
  agents: async ({ request }) => {
    const session = await auth(request);
    return { support: new OmnaraAgent({ ...omnaraConfig, user: { id: session.userId } }) };
  },
});
```

## What it does

| Omnara | AG-UI |
| --- | --- |
| Text and reasoning previews, completed by `model_output` | `TEXT_MESSAGE_*`, `REASONING_*` (streamed live) |
| Tool calls and results | `TOOL_CALL_*`, `TOOL_CALL_RESULT` (files as `[file]`) |
| A custom call to one of the page's tools | `TOOL_CALL_*`, then `RUN_FINISHED` with `pendingToolCallIds`; the page's result goes back as the call's result |
| A `permission` or `question` interaction | `RUN_FINISHED` with an interrupt (`omnara:permission`, `omnara:question`); the resume answers it |
| [Subagent](https://docs.omnara.com/tools/built-in#subagents) reports; messages from other people (Omnara's dashboard, the API, Slack) | Assistant messages for reports, user messages for everyone else; both carry the sender's `name` |
| The log | `MESSAGES_SNAPSHOT` at the end of every run |
| The thread's agent is created | `CUSTOM` `omnara.agent` with `{ agentId, threadId }` |

### Context and attachments

`RunAgentInput.context` reaches the model as a hidden block; inline images and documents are sent as files, and other parts become a note to the model.

### Browser tools

Tools in `RunAgentInput.tools` are added to the thread's Omnara agent as [custom tools](https://docs.omnara.com/tools/custom) (profiles are never changed); a tool the agent's definition already declares keeps the definition's version. A browser tool call the page never answers (a new message arrives without its result) is cancelled with Omnara's cancel before the message is delivered.

### Backend tools

Tools your server runs go in `backendTools`:

```typescript
new OmnaraAgent({
  ...config,
  backendTools: [
    {
      name: "get_weather",
      description: "Get the weather for a location.",
      parameters: { type: "object", properties: { location: { type: "string" } } },
      handler: async (input, { toolCallId }) => ({ temperature: 21 }),
    },
  ],
});
```

A handler runs while a request is following the agent, and must be safe to run twice for the same `toolCallId`: two servers following one agent can both pick up a call before Omnara records the first result. A handler's error is returned to the agent as a failed result.

### Approvals and questions

An interrupt carries Omnara's [approval or question form](https://docs.omnara.com/events/interactions) in `metadata.omnara` (`kind`, `form`, `agentId`, `agentName`, `toolName`) and a `responseSchema`. Resume with:

- permission: `{ approved: boolean, reason?: string }`
- question: `{ answers: [{ optionIndices: number[], text?: string }] }`, one entry per question

A `cancelled` resume entry lets the agent continue: a permission is denied, a question gets its "Other" option with a note. Subagent approvals and questions arrive the same way.

### Stop and disconnect

`abortRun()` (CopilotKit's Stop button) cancels the agent and its running subagents with Omnara's cancel, and ends the run as cancelled. A closed tab or dropped connection cancels nothing: the agent keeps working, and the next run catches the chat up from the log.

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `OMNARA_API_KEY` | [Org API key](https://docs.omnara.com/api/authentication#org-api-keys-for-services) with the developer role on the project. |
| `orgId`, `projectId` | required | |
| `baseUrl` | `https://api.omnara.com/v1` | A [self-hosted](https://docs.omnara.com/self-hosting/deployment) Omnara serves its API at `https://<your-host>/api/v1`. |
| `profile` | | Profile id (`aprf_...`) or name. A thread keeps the agent it started with, so changing the profile (or editing it) applies to new threads. |
| `definition` | | Inline `{ source, format? }`; `source` is a YAML or JSON string or an object. Changes apply to new threads, as with a profile. |
| `user` | required | `{ id, tenant?, name? }` from your auth, or `"anonymous"` for demos; the Omnara actor on everything the adapter sends. |
| `backendTools` | `[]` | Tools your server runs. |
| `onError` | `console.error` | Receives absorbed failures and the full upstream error text. |

Give exactly one of `profile` and `definition`.

## Errors

`RUN_ERROR` carries a stable `code` and a generic message; upstream text goes to `onError`, never to the client.

| Code | When |
| --- | --- |
| `thread_ended` | The thread's Omnara agent was archived. Start a new thread. |
| `invalid_tools` | Omnara rejected the tools (the page's or `backendTools`). |
| `message_too_large` | A message plus the page's context is over Omnara's 1 MiB limit. The thread can't continue past it; start a new one. |
| `model_error` | The model call failed for good. |
| `run_failed` | Anything else, such as Omnara being unreachable. Retrying is safe. |

## Limits

- **Check thread ownership.** The adapter keys each thread's agent by user, but CopilotKit's in-memory runner replays and stops runs by thread id alone. Check that the caller owns the thread in `beforeRequestMiddleware`.
- **A thread belongs to one user.** To continue a chat as someone else (a guest who signs in, say), start a new thread: that user's agent would receive the whole chat.
- **Tool results over 1 MiB** reach the agent as a failed result saying so.
- **The adapter owns the custom tools it adds to a thread's agent.** A custom tool added to that agent another way (in Omnara's dashboard, say) is removed with the next request; put tools in the profile or definition instead.
- **Don't make the Omnara agent CopilotKit's suggestions provider.** Each suggestion with `instructions` would launch a new Omnara agent.
- **No updates while the chat is idle.** AG-UI has no channel for them; what happened meanwhile appears with the next request.
- **With nested subagents ([`max_depth`](https://docs.omnara.com/agents/configuration) above 1), a run can end before their work does.** What they report appears with the next request.
- **After a CopilotKit server restart the chat shows only new messages.** The runner keeps history in memory; Omnara still has it all.
- **Files the agent creates aren't shown.** Omnara files ([artifacts](https://docs.omnara.com/events/artifacts)) can only be downloaded with the API key, so the browser can't load them. Tool results and messages show `[file]` where one was.

## Running the dojo

The dojo runs the Omnara agents in-process (`apps/dojo/src/agents.ts`), so there is no separate server:

```bash
cd apps/dojo
OMNARA_API_KEY=... OMNARA_ORG_ID=org_... OMNARA_PROJECT_ID=proj_... pnpm dev
```

Visit http://localhost:3000 and select **Omnara**. `OMNARA_MODEL_PROVIDER` and `OMNARA_MODEL` pick the model; the defaults exist only in the hosted dojo's project, so set them to a [model provider](https://docs.omnara.com/organization/model-providers) and model in yours.
