# BEFORE MERGE — temporary changes to revert

This branch (`mme/subagents`) carries a few **temporary** changes that exist only
to make the cross-repo **pkg.pr.new preview** loop work while `@ag-ui` 0.0.58 is
unpublished (so the sibling CopilotKit PR can consume this branch's preview). They
are NOT part of the subagent feature and MUST be reverted before merge.

> The real feature changes (subagent protocol on the TS + Python SDKs, the
> LangGraph deepagents attribution, the `@ag-ui/core` 0.0.57 → 0.0.58 version bump,
> the dojo demo) are permanent — do NOT revert those.

## 1. Integration/middleware peer/deps flipped to `workspace:*`
**Why:** pkg.pr.new only rewrites `workspace:*` deps into preview URLs. These
packages intentionally declare their `@ag-ui/*` SDK deps as open ranges
(`>=0.0.4x`) for published flexibility, so their previews carried unresolvable
semver deps. Flipping to `workspace:*` makes the previews self-consistent.

**Revert:** restore the original `>=0.0.x` ranges (from `origin/main`) in the 21
package.json files below.

```
git checkout origin/main -- \
  integrations/llama-index/typescript/package.json \
  integrations/langgraph/typescript/package.json \
  integrations/vercel-ai-sdk/typescript/package.json \
  integrations/mastra/typescript/package.json \
  integrations/langchain/typescript/package.json \
  integrations/a2a/typescript/package.json \
  integrations/crew-ai/typescript/package.json \
  integrations/pydantic-ai/typescript/package.json \
  integrations/aws-strands/typescript/package.json \
  integrations/watsonx/typescript/package.json \
  integrations/claude-agent-sdk/typescript/package.json \
  integrations/ag2/typescript/package.json \
  integrations/adk-middleware/typescript/package.json \
  integrations/agno/typescript/package.json \
  integrations/community/spring-ai/typescript/package.json \
  integrations/community/cloudflare-agents/typescript/package.json \
  integrations/langroid/typescript/package.json \
  middlewares/a2a-middleware/package.json \
  middlewares/event-throttle-middleware/package.json \
  middlewares/mcp-apps-middleware/package.json \
  middlewares/a2ui-middleware/package.json
```

## 2. Root `package.json` pnpm.overrides: `workspace:*` → `link:` paths
**Why:** the dojo consumes published `@copilotkit/*`, and a `workspace:*` override
value does not rewrite a published package's transitive `@ag-ui` deps; `link:`
paths do, forcing the dojo's CopilotKit onto this workspace's subagent-capable
`@ag-ui` build for the demo.

**Revert:** change the four `@ag-ui/*` overrides back from
`link:sdks/typescript/packages/*` to `workspace:*` in `package.json`, then
`pnpm install` to regenerate `pnpm-lock.yaml`.

---

Once `@ag-ui` 0.0.58 is published to npm, all of the above become unnecessary and
should be undone in the same PR that drops the pkg.pr.new plumbing on the
CopilotKit side (see that repo's `BEFORE-MERGE.md`).
