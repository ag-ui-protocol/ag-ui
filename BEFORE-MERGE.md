# BEFORE MERGE — temporary changes to revert

This branch (`mme/subagents`) carries **temporary** changes that exist only to
wire the cross-repo preview loop with the sibling CopilotKit PR while `@ag-ui`
0.0.58 is unpublished. They are NOT part of the subagent feature and MUST be
reverted before merge.

> The real feature changes (subagent protocol on the TS + Python SDKs, the
> LangGraph deepagents attribution, `@ag-ui/core` 0.0.57 → 0.0.58, the dojo demo)
> are permanent — do NOT revert those.

## 1. Root `package.json` pnpm.overrides: `workspace:*` → `link:` paths
**Why:** the dojo consumes published `@copilotkit/*`, and a `workspace:*` override
value does not rewrite a published package's transitive `@ag-ui` deps; `link:`
paths do, forcing the dojo's CopilotKit onto this workspace's subagent-capable
`@ag-ui` build for the demo.

**Revert:** change the four `@ag-ui/*` overrides back from
`link:sdks/typescript/packages/*` to `workspace:*` in `package.json`, then
`pnpm install` to regenerate `pnpm-lock.yaml`.

---

## Note: pkg.pr.new URL consumption was attempted and abandoned
Flipping integration/middleware `@ag-ui` peer/deps to `workspace:*` (so pkg.pr.new
would rewrite them to preview URLs) was tried and **reverted** — it breaks
pkg-pr-new's per-package `pnpm pack` step (`pnpm pack` cannot resolve `workspace:*`
in isolation). Conversely, leaving them as the intentional `>=0.0.4x` ranges means
the previews carry semver `@ag-ui` deps that a consumer's pnpm dedupes to the
url-only `0.0.58` and then fails to fetch from npm.

**Conclusion:** the CopilotKit monorepo cannot consume `@ag-ui` 0.0.58 via
pkg.pr.new URLs. Consume it via an `@ag-ui` **canary npm publish** instead
(registry-resolvable `0.0.58-canary.x`; CopilotKit's `.npmrc` already excludes
`@ag-ui/*` from `minimum-release-age` for exactly this). See the CopilotKit PR.
