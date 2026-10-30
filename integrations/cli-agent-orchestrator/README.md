# CLI Agent Orchestrator (CAO) in the AG-UI Dojo — run it locally

[CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) runs coding-agent
CLIs (Claude Code, Kiro CLI, Codex, and others) as real processes in tmux and serves AG-UI at
`POST /agui/v1/run`. When one of those CLIs stops at a permission prompt, CAO reports it as an
AG-UI interrupt, and the answer you give in the browser is typed into that CLI.

This integration is **local only**. Nothing is hosted and no CI lane runs it, because it needs
a real CLI that is logged in on your machine. In the Dojo it backs one page, **Tool Approval**.
The other standard Dojo features are left out because CAO can't genuinely back them yet.

## How the demo works

1. A Claude Code agent, run by CAO in tmux, is told to write one file. Claude Code stops and
   asks permission.
2. You send any message in the Dojo chat. The Dojo calls `POST /agui/v1/run`, CAO answers
   `RUN_FINISHED` with an `interrupt` outcome, and the page shows an approval card.
3. **Approve** makes CAO press Enter in that terminal, so the file is written. **Reject** makes
   it press Escape, so the write is declined.

> The Dojo message does **not** instruct the agent. CAO's run endpoint does not route chat text
> to agents; the agent's task is started from the command line (step 4 below). The message only
> collects the approval that is waiting.

The card shows the prompt type, the CLI and the terminal id, but not the prompt's text. CAO
puts only metadata on the AG-UI wire, never terminal output, so the tmux pane is where you see
what is being asked.

## Prerequisites

- macOS or Linux, with `tmux`, `curl` and [`uv`](https://docs.astral.sh/uv/)
- Python 3.11 or later for CAO (`uv` downloads one if none is installed)
- Node.js 22 and `pnpm` (see the [Dojo README](../../apps/dojo/README.md))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and logged in
  (`claude` works in a terminal). The demo uses the `haiku` model and costs a few hundred tokens.

## Run it

1. **Install CAO.** The demo needs two CAO fixes (the run finishing after a decision, and
   detecting Claude Code's permission prompt) that are not in a release yet. Until they are,
   install the commit that carries both:

   ```bash
   uv tool install 'cli-agent-orchestrator[agui] @ git+https://github.com/awslabs/cli-agent-orchestrator@666ca844ad9dd8fd94b67d2c62f8bef4cdebf2ce'
   cao init
   ```

   This line moves to the awslabs release once it is on PyPI:
   `uv tool install 'cli-agent-orchestrator[agui]'`.

2. **Start CAO and the agent.** From the repository root:

   ```bash
   integrations/cli-agent-orchestrator/scripts/run-local.sh
   ```

   This starts `cao-server` on `127.0.0.1:9889` with `CAO_AGUI_ENABLED=1` (unless one is already
   running), installs the [`agui-approver`](agui-approver.md) profile, and launches the agent in a
   fresh temp directory, so its one file write never touches this repository.

3. **Watch the agent** (optional, in another terminal):

   ```bash
   tmux attach -t cao-agui-demo     # detach with Ctrl-b d
   ```

   Claude Code then shows `Do you want to create approved-by-dojo.txt?`. That takes about 20
   seconds, longer if your own Claude Code hooks are slow to start.

4. **Start the Dojo** in dev mode. Local-only integrations appear in the picker only in
   development:

   ```bash
   pnpm install
   pnpm build --projects=demo-viewer      # first run only
   cd apps/dojo && CAO_URL=http://127.0.0.1:9889 pnpm dev
   ```

   The first page load compiles the route and can take about a minute.

5. **Approve.** Open <http://localhost:3000/cli-agent-orchestrator/feature/tool_approval>, send
   any message, and click **Approve** on the card. In the tmux pane Claude Code continues, writes
   `approved-by-dojo.txt`, and replies that it did.

6. **Reject.** Relaunch the demo, so a fresh agent in a fresh temp directory asks again. (The
   same agent would only report that the file already exists.)

   ```bash
   integrations/cli-agent-orchestrator/scripts/run-local.sh --down
   integrations/cli-agent-orchestrator/scripts/run-local.sh
   ```

   When the pane shows the prompt, send another message in the Dojo and click **Reject**. Claude
   Code reports `User rejected write to approved-by-dojo.txt` and the file is not created.

7. **Tear down:**

   ```bash
   integrations/cli-agent-orchestrator/scripts/run-local.sh --down
   ```

   This shuts down the demo session, removes its temp directory, and stops `cao-server` if the
   script started it. The `agui-approver` profile stays installed in your CAO profile store;
   remove it with `cao profile remove agui-approver --yes` if you don't want it.

## Check it yourself

`scripts/e2e-local.sh` runs steps 2 to 7 unattended in a headless browser: approve, reject, and a
message with nothing pending. It checks the card, the file, and that every run ends within 15
seconds, then tears everything down. It exits 0 only if all checks pass. It is local only and no CI
lane runs it. Set `E2E_VIDEO_DIR` or `E2E_SHOT_DIR` to keep a video or screenshots of each step.
It drives the browser with the Dojo's Playwright, so install it and its Chromium once first:
`cd apps/dojo/e2e && pnpm install --ignore-scripts && npx playwright install chromium`.

## Troubleshooting

- **No card appears.** The agent may not be at its prompt yet. Check the pane, then send the
  message again. A message sent while nothing is pending just finishes with no card.
- **The agent waits at a prompt, but no card appears.** CAO detects permission prompts by their
  on-screen layout. If a Claude Code update changes that layout, CAO raises no interrupt and the
  agent waits at its prompt in tmux. Check with `tmux attach -t cao-agui-demo`.
- **`AG-UI is disabled`.** A `cao-server` was already running without the AG-UI surface. Stop it
  and rerun the script, or restart it yourself with `CAO_AGUI_ENABLED=1 cao-server`.
- **The agent never asks permission.** The profile sets `permissionMode: default`. Without it,
  CAO launches Claude Code with `--dangerously-skip-permissions` and nothing prompts. The
  script's `cao launch --auto-approve` is unrelated: it only skips CAO's own launch confirmation.
  The other cause is your own Claude Code settings: an allow rule for `Write` (for example in
  `~/.claude/settings.json` under `permissions.allow`) means Claude Code never asks.
- **Claude Code asks you to log in in the pane.** Run `claude` once in a normal terminal and log
  in, then rerun the script.
- **Security.** `cao-server` has authentication turned off by default and runs commands for
  anyone who can reach it. Keep it on loopback; the script refuses any other `CAO_HOST`.

## Using the client elsewhere

The TypeScript client, [`@ag-ui/cli-agent-orchestrator`](typescript/README.md), is a plain
`HttpAgent` pointed at `http://127.0.0.1:9889/agui/v1/run`. CAO's AG-UI surface is documented in
the CAO repository's [`docs/agui.md`](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md).
