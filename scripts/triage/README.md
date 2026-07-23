# Issue triage automation

Stop-the-bleeding automation for incoming issues. Three workflows, one shared
analysis module. Everything is **advisory / high-confidence / reopen-friendly** —
nothing closes an issue on an LLM's say-so.

| Workflow              | Trigger                      | LLM? | What it does                                                                                                                                                                                     |
| --------------------- | ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `triage-stale.yml`    | daily cron                   | no   | Marks `needs-info` issues stale after 14d of silence, closes 7d later. Scoped to `needs-info` only, so it never touches active issues. Exempts `Roadmap,proposal`. PRs untouched. |
| `triage-on-open.yml`  | `issues: opened`             | yes  | One combined classify + dedup pass. Applies allow-listed labels (conf ≥ 0.75) and flags likely duplicates with an advisory comment (conf ≥ 0.8). Never closes.                                   |
| `triage-backfill.yml` | manual (`workflow_dispatch`) | yes  | Same analysis over the existing open backlog. **Dry-run by default** — previews in the job summary; only applies when you uncheck dry-run. Capped by `max_issues`.                               |

`analyze.js` is the single source of truth for the LLM logic (search for
candidates → one combined Anthropic call → return proposals). Both the on-open
and backfill workflows call it, so policy and safety controls live in one place.

## Setup

1. **Model provider** — the two LLM workflows need ONE provider; with none they
   clean-skip (log and exit, no failures). `triage-stale` needs nothing.
   - **Azure OpenAI / Foundry (preferred — draws on shared credits):** secret
     `AZURE_OPENAI_API_KEY`; repo **Variables** `AZURE_OPENAI_ENDPOINT` and
     `AZURE_OPENAI_DEPLOYMENT` (optional `AZURE_OPENAI_API_VERSION`, default `2024-10-21`).
   - **Anthropic (fallback):** secret `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`).
   - Force one with the `TRIAGE_PROVIDER` variable (`azure` | `anthropic`); otherwise
     it's inferred from whichever credentials are present (Azure wins if both are set).
2. **Curate the label allow-list.** The classifier may apply _only_ the labels in
   `APPLYABLE` (top of `triage-on-open.yml` / `triage-backfill.yml`). It's
   default-deny and currently holds the repo's real content labels only —
   `bug, enhancement, documentation, question, Integration, SDK, framework, Agent Framework`.
   `enhancement` is this repo's canonical feature type; the rarely-used `Feature Request`
   synonym is deliberately omitted. Curation/disposition labels (`proposal`, `Roadmap`,
   `good first issue`, `help wanted`, `release`, `invalid`, `wontfix`…) are excluded —
   those are human calls. Adjust per repo.
3. **Create a `needs-info` label** (this repo doesn't have one yet). Until it exists
   and gets applied, `triage-stale` is a clean no-op — it only acts on `needs-info`.
4. **First run:** dispatch `triage-backfill` with dry-run **on** and a small
   `max_issues` to eyeball the proposals before letting it apply anything.

## Safety model

- **Constrained action space** — the LLM never posts free text. It returns
  structured JSON; the workflow applies validated labels and templated comments.
- **Default-deny labels** — only allow-listed labels can be applied.
- **Confidence gates** — labels ≥ 0.75, dedup ≥ 0.8; dedup also requires the
  target to be one of the candidates we actually searched.
- **Flag, never close** — duplicates get a label + a "a maintainer will confirm"
  comment. Humans close.
- **Spam/low-signal gate** — already-flagged or empty-body-from-outsider issues
  skip the LLM call entirely (cost guard).
- **Pinned actions** — checkout / github-script / stale are SHA-pinned, with
  `persist-credentials: false` (no git ops).
- **Least privilege** — `issues: write` is scoped to the job, not the workflow;
  no other token scopes are granted.
- **No template injection** — `workflow_dispatch` inputs are passed via `env`
  and read from `process.env`, never interpolated into the inline script.
