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
   it press Escape, so the write is declined. If sending the answer fails, the card stays with a
   "Not delivered" notice, and answering again resumes the same interrupt.

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

1. **Install CAO.** The demo needs CAO fixes (the run finishing after a decision, detecting Claude
   Code's permission prompt, and starting current Claude Code versions) that are not in a release
   yet. Until they are, install this commit from awslabs `main`, which carries them:

   ```bash
   uv tool install 'cli-agent-orchestrator[agui] @ git+https://github.com/awslabs/cli-agent-orchestrator@367f53f3e2ba9d64dd276b9ab438a4e384072611'
   cao init
   ```

   This line moves to the awslabs release once it is on PyPI:
   `uv tool install 'cli-agent-orchestrator[agui]'`.

2. **Start CAO and the agent.** All the commands below use paths relative to **the checkout root**
   (the top-level directory of your ag-ui clone, not a subdirectory such as `apps/dojo`). Start
   from there:

   ```bash
   cd /path/to/your/ag-ui/checkout
   integrations/cli-agent-orchestrator/scripts/run-local.sh
   ```

   Each run gets its own temp directory and its own `cao-server` on `127.0.0.1:9898`
   (`CAO_PORT` changes it; the script refuses a port that is taken), with `CAO_AGUI_ENABLED=1` and
   CAO state kept inside that directory. Your other CAO sessions are never involved, and their
   prompts never reach the Dojo. The script installs the [`agui-approver`](agui-approver.md)
   profile, launches the agent in a fresh temp directory, so its one file write never touches this
   repository, and prints `RUN_DIR`, `CAO_URL` and `SESSION`. Keep the `RUN_DIR` line: teardown
   needs it.

3. **Watch the agent** (optional, in another terminal):

   ```bash
   tmux attach -t <SESSION>     # the SESSION line the script printed; detach with Ctrl-b d
   ```

   Claude Code then shows `Do you want to create approved-by-dojo.txt?`. That takes about 20
   seconds, longer if your own Claude Code hooks are slow to start.

4. **Start the Dojo** in dev mode. Local-only integrations appear in the picker only in
   development:

   ```bash
   cd /path/to/your/ag-ui/checkout
   pnpm install
   pnpm build --projects=demo-viewer      # first run only
   cd apps/dojo && CAO_URL=http://127.0.0.1:9898 pnpm dev -H 127.0.0.1
   ```

   `-H 127.0.0.1` keeps the Dojo on loopback. Its runtime route has no authentication and forwards
   to cao-server, so anyone who can reach the Dojo can answer the agent's permission prompts.
   The first page load compiles the route and can take about a minute.

5. **Approve.** Open <http://127.0.0.1:3000/cli-agent-orchestrator/feature/tool_approval>, send
   any message, and click **Approve** on the card. In the tmux pane Claude Code continues, writes
   `approved-by-dojo.txt`, and replies that it did.

6. **Reject.** Relaunch the demo, so a fresh agent in a fresh temp directory asks again. (The
   same agent would only report that the file already exists.) The Dojo from step 4 keeps running
   in `apps/dojo` in its terminal, so **open a new terminal** and go to the checkout root:

   ```bash
   cd /path/to/your/ag-ui/checkout
   integrations/cli-agent-orchestrator/scripts/run-local.sh --down <RUN_DIR from step 2>
   integrations/cli-agent-orchestrator/scripts/run-local.sh
   ```

   When the pane shows the prompt, send another message in the Dojo and click **Reject**. Claude
   Code reports `User rejected write to approved-by-dojo.txt` and the file is not created.

7. **Tear down.** From the checkout root, in a terminal other than the Dojo's (stop the Dojo with
   Ctrl-C in its own):

   ```bash
   cd /path/to/your/ag-ui/checkout
   integrations/cli-agent-orchestrator/scripts/run-local.sh --down <RUN_DIR from the latest run>
   ```

   This stops that run's agent session and its `cao-server`, and removes its temp directories. It
   touches nothing else. If the server does not exit in time the script keeps the run directory
   and exits non-zero; run it again. The demo's CAO state lives inside the run directory, so
   nothing is left in your own CAO profile store.

## Check it yourself

`scripts/e2e-local.sh` runs steps 2 to 7 unattended in a headless browser: approve, reject, a
message with nothing pending, and two approvals whose first answer is dropped, once before it
reaches CAO and once after CAO has acted on it (the card must stay with a "Not delivered" notice and
the sent answer locked, and answering again must resend that same answer and finish with the file
written). It checks the card, the file, and that every run ends within 15
seconds, then tears everything down. It exits 0 only if all checks pass. It is local only and no CI
lane runs it. Set `E2E_VIDEO_DIR` or `E2E_SHOT_DIR` to keep a video or screenshots of each step.
It drives the browser with the Dojo's Playwright, so install it and its Chromium once first, from the checkout root (the Dojo terminal from step 4 is
in `apps/dojo`, which is inside the checkout but is not its root):

```bash
cd /path/to/your/ag-ui/checkout
(cd apps/dojo/e2e && pnpm install --ignore-scripts && npx playwright install chromium)
```

Then run it from the checkout root, with nothing else on ports 3000 or 9898 (it starts its own Dojo
and demo):

```bash
cd /path/to/your/ag-ui/checkout
integrations/cli-agent-orchestrator/scripts/e2e-local.sh
```

## Troubleshooting

- **No card appears.** The agent may not be at its prompt yet. Check the pane, then send the
  message again. A message sent while nothing is pending just finishes with no card.
- **The agent waits at a prompt, but no card appears.** CAO detects permission prompts by their
  on-screen layout. If a Claude Code update changes that layout, CAO raises no interrupt and the
  agent waits at its prompt in tmux. Check with `tmux attach -t <SESSION>`.
- **`port 9898 is already in use`.** Something else listens there, or an earlier run is still up.
  Tear that run down with its `RUN_DIR`, or set `CAO_PORT` to a free port (and use the same port in
  the Dojo's `CAO_URL`).
- **The agent never asks permission.** The profile sets `permissionMode: default`. Without it,
  CAO launches Claude Code with `--dangerously-skip-permissions` and nothing prompts. The
  script's `cao launch --auto-approve` is unrelated: it only skips CAO's own launch confirmation.
  The other cause is your own Claude Code settings: an allow rule for `Write` (for example in
  `~/.claude/settings.json` under `permissions.allow`) means Claude Code never asks.
- **Claude Code asks you to log in in the pane.** Run `claude` once in a normal terminal and log
  in, then rerun the script.
- **Security.** `cao-server` has authentication turned off by default and runs commands for
  anyone who can reach it. The script only ever binds `127.0.0.1`.

## Using the client elsewhere

The TypeScript client, [`@ag-ui/cli-agent-orchestrator`](typescript/README.md), is a plain
`HttpAgent` pointed at `http://127.0.0.1:9898/agui/v1/run` (CAO's own default port is 9889). CAO's AG-UI surface is documented in
the CAO repository's [`docs/agui.md`](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md).
