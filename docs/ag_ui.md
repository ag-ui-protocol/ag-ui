# AG‑UI: The Agent–User Interaction Protocol

*A horizontal standard to bring AI agents into user‑facing frontend applications.*

AG‑UI is the boundary layer where agents and users meet. It standardizes how agent state, UI intents, and user interactions flow between your model/agent runtime and your app’s frontend—so you can ship reliable, debuggable, user‑friendly agentic features fast.

---

## Built with the ecosystem

**First‑party partnerships & integrations**

> **Logo strip goes here** (e.g., LangGraph • CrewAI • Autogen 2 • LlamaIndex • Mastra • Pydantic AI • Vercel AI SDK • Next.js)

Short blurb: *AG‑UI works across leading agent frameworks and frontend stacks, with shared vocabulary and primitives that keep your UX consistent as your agents evolve.*

---

## Building blocks (today & upcoming)

- **Streaming chat** — Token‑level and tool‑event streaming for responsive UIs.
- **Static generative UI** — Render model output into stable, typed components.
- **Declarative generative UI** — Let agents propose UI trees; app decides what to mount.
- **Frontend tools** — Safe, typed tool calls that bridge agent logic to app actions.
- **Interrupts & human‑in‑the‑loop** — Pause, approve, edit, or steer mid‑flow.
- **In‑chat + in‑app interactions** — Chat commands alongside regular app controls.
- **Attachments & multimodality** — Files, images, audio, and structured payloads.
- **Thinking steps** — Expose summaries/redactions of chain‑of‑thought artifacts to users, safely.
- **Sub‑agent calls** — Orchestrate nested agents and delegate specialized tasks.
- **Agent steering** — Guardrails, policies, and UX affordances to keep agents on track.

> **CTA to deeper docs** → *See the full capability map in the docs.*

---

## Design patterns

Explore reusable interaction patterns for agentic UX:

- **Link‑out:** [AI‑UI Design Patterns →](/patterns) *(placeholder URL)*

---

## Why AG‑UI

**Agentic apps break the classic request/response contract.** Agents run for longer, stream work as they go, and make nondeterministic choices that can affect your UI and state. AG‑UI defines a clean, observable boundary so frontends remain predictable while agents stay flexible.

### What’s hard about user‑facing agents

- Agents are **long‑running** and **stream** intermediate work—often across multi‑turn sessions.
- Agents are **nondeterministic** and can **control UI** in ways that must be supervised.
- Apps must mix **structured + unstructured IO** (text, voice, tool calls, state updates).
- Agents need **composition**: agents **call sub‑agents**, often non-deterministically.

With AG‑UI, these become deliberate, well‑typed interactions rather than ad‑hoc wiring.

---

## Deeper proof (docs, demos, code)

| Framework / Platform    | What works today                       | Docs      | Demo      |
| ----------------------- | -------------------------------------- | --------- | --------- |
| LangGraph               | Streams, tools, interrupts, sub‑agents | [Docs](#) | [Demo](#) |
| CrewAI                  | Tools, action routing, steering        | [Docs](#) | [Demo](#) |
| Autogen 2               | Multi‑agent orchestration, messaging   | [Docs](#) | [Demo](#) |
| LlamaIndex              | Query/agent routing, UI intents        | [Docs](#) | [Demo](#) |
| OpenAI Realtime         | Live stream, events, attachments       | [Docs](#) | [Demo](#) |
| Vercel AI SDK / Next.js | Edge streaming, SSR hydration          | [Docs](#) | [Demo](#) |

> **Note:** Replace placeholders with actual URLs to docs and demos.

---

## Quick links

- **Get started** → */docs/getting-started* (placeholder)
- **Concepts** → */docs/concepts/agent-ui-boundary* (placeholder)
- **Reference** → */docs/reference* (placeholder)
- **Patterns** → */patterns* (placeholder)

---

## Optional section: How AG‑UI fits

- **Protocol**: Events, intents, and payload schemas shared by agents & apps.
- **Runtime adapters**: Bindings for popular agent frameworks.
- **Frontend kit**: Lightweight client + components to handle streaming & interrupts.
- **Observability hooks**: Surface interaction timelines for debugging & learning.

*(Include a simple diagram later: Agent(s) ⇄ AG‑UI Boundary ⇄ App UI/State)*

