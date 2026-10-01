# AG-UI Protocol Dojo

A modern, interactive viewer for exploring CopilotKit agent demos with a clean, responsive UI and dark/light theme support.

## Overview

The Demo Viewer provides a centralized interface for browsing, viewing, and exploring the source code of various CopilotKit agent demos. It features:

- Clean, modern UI with dark/light theme support
- Interactive demo previews
- Source code exploration with syntax highlighting
- Organized demo listing with tags and descriptions
- LLM provider selection

## Development Setup

To run the Demo Viewer locally for development, follow these steps:

### Install dependencies

```bash
brew install protobuf
```

Note that running the dojo currently requires the use of `pnpm` (vs `yarn` or `npm`) do to how we handle  workspace dependencies.
```bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

The first time you want to run, you need to build all of the dojos dependencies throught the repository.
```
# from the ag-ui repository root
pnpm i
pnpm build --projects=demo-viewer
```

### Run the Demo Viewer

There are 3 ways to run the demo viewer

- Run just the demo viewer, and run the agent(s) separately
- Run the dev script for the entire repo, and run the agent(s) separately
- use the `dojo-everything` scripts

#### Run just the demo viewer, and run the agent(s) separately.

In one terminal, you can `cd` into the dojo directory and run `pnpm dev` to just run the dojo
This will not capture updates to dependencies of the dojo
In another terminal, you'll need to run any other agents you want to test separately, see "Run Agents" below.
The dojo will start on port 3000 by default

Note that some agents may run on colliding ports

#### Run the dev script for the entire repo, and run the agent(s) separately
In one terminal, you can run `pnpm dev` from the *repository root*
This WILL automatically rebuild dependencies, for example if you change the mastra integration, it will automatically rebuild and be bundled into the dojo with HMR.
In another terminal, you'll need to run any other agents you want to test separately, see "Run Agents" below.
The dojo will start on port 3000 by default

Note that some agents may run on colliding ports

#### Run Agents
Agent examples for the dojo are generally located in `integrations/{integrationName}/{language}/examples`. A readme there should explain what you need to do to run the example, but it's usually either `npm dev` for typescript packages, or `poetry install && poetry run dev` or `uv sync && uv run dev` for python servers.

Note that some agents may run on colliding ports

#### Use the `dojo-everything` scripts

These are the easiest ways to run everything. They will automatically configure all of your ports to not be colliding, provide that information to the dojo, and spin up the dojo.

```
# In the apps/dojo directory
./scripts/prep-dojo-everything.js
./scripts/run-dojo-everything.js
```

The demo viewer will now run on port 9999.

The one caveat here is that (for precompiled speed while running tests) this runs a production nextjs build, and that build has to be redone if you modify the dojo code at all (or any of the typescript integrations).

You can look in the `run-dojo-everything.js` script and see which ports it runs agents at, and export those as environment variables, which can be found in `apps/dojo/src/env.ts`. Then you can run the dojo via `pnpm dev` at the repo root, to get live updates to typescript integrations and the dojo. There is not HMR on most of the python framework agent examples.

To choose which agents or services the `run-dojo-everything.js` script runs you can use the `--only` flag, like this: `./scripts/run-dojo-everything.js --only adk-middleware,langgraph-fastapi`. The names for these IDs match what is in `src/agents.ts` as well as being findable in the run-dojo-everything script. .

### Adding a new integration
Integrations should go in `integrations/{integrationID}`. There should always be a typescript folder that at least contains the client, and possibly a python (or other language) folder.

To add it to the dojo, please make sure it gets added to
- src/agents.ts
- src/menu.ts
- scripts/prep-dojo-everything.js
- scripts/run-dojo-everything.js
- e2e.yml
- the `LANES` table in `scripts/published-mode.js` (its unit test fails if it drifts from the e2e matrix)
- the `apps/dojo/e2e` folder, look in the tests folder of other frameworks, and you should be able to mostly dupiclate these.

## Published mode (run lanes against released packages)

By default every Dojo lane runs against repo source: `@ag-ui/*` resolve through
`workspace:*`, Python examples use path dependencies / `[tool.uv.sources]`
overrides and their committed locks, and the AG-UI .NET sample uses
`ProjectReference`s. Published mode instead runs a lane against the latest
**published** releases, which is what proves that a framework's public release
works with the current protocol.

`scripts/published-mode.js apply --lanes <suite>` rewrites the checkout in place:

| Ecosystem | What changes |
| --- | --- |
| npm | Every `@ag-ui/*` `workspace:*` dependency of `apps/dojo` (and of the lane's example package) is pinned to the version npm's `latest` tag points at. Packages that are not on npm (e.g. `@ag-ui/server-starter`, `@ag-ui/langroid`) stay on source, but their own `@ag-ui/*` deps are switched too. The `tsconfig.json` aliases that point `@ag-ui/client` at repo source are removed. |
| PyPI | The lane's integration package (ours, e.g. `ag-ui-langgraph`, or the upstream producer's: `pydantic-ai-slim`, `ag2`, `agent-framework-ag-ui`, `agno`, `llama-index-protocols-ag-ui`) is pinned to `>=` its PyPI latest, path sources for it and `ag-ui-protocol` are dropped, example-level bounds on `ag-ui-protocol` / `ag-ui-a2ui-toolkit` are relaxed, and `uv.lock` / `poetry.lock` is deleted so the environment is resolved from scratch. |
| NuGet | `ag-ui-dotnet`: `ProjectReference`s to `AGUI.Abstractions`, `AGUI.Server` and `AGUI.Formatting` become `PackageReference`s at their NuGet latest; `AGUI.A2UI` is not on NuGet yet and still builds from source (against the published packages). `microsoft-agent-framework-dotnet`: `Microsoft.Agents.AI.*` are bumped to their NuGet latest (and the example's old direct `OpenAI` / `System.Net.ServerSentEvents` pins are dropped so they don't downgrade what MAF needs). |

`ag-ui-protocol` is deliberately not forced: the report shows the version the
producer's own constraints allowed and marks it `(not latest)` when that is not
the newest release, which is the signal that a producer still caps the protocol.
The `claude-agent-sdk-typescript` lane runs its adapter from source (the example
server imports `../src`); only its `@ag-ui/*` deps are switched.

The script edits files in place, so use a throwaway checkout or a worktree
(`.published-mode/` at the repo root holds its state and is git-ignored):

```bash
# from a scratch worktree of the repo root

# 1. Rewrite one lane (preview with --dry-run; `list` shows every lane id,
#    which are the `suite` names in .github/workflows/dojo-e2e.yml)
node apps/dojo/scripts/published-mode.js apply --lanes agno --dry-run
node apps/dojo/scripts/published-mode.js apply --lanes agno

# 2. Install without the frozen lockfile, then prepare and run the lane as usual
pnpm install --no-frozen-lockfile
cd apps/dojo
node ./scripts/prep-dojo-everything.js --only dojo,agno
cd e2e && pnpm install && node ../scripts/run-dojo-everything.js --only dojo,agno
# in another terminal, from apps/dojo/e2e
BASE_URL=http://localhost:9999 PLAYWRIGHT_SUITE=agno pnpm test -- tests/agnoTests

# 3. Show what each package actually resolved to (run from the repo root)
node apps/dojo/scripts/published-mode.js report --lane agno --outcome success
```

In CI, `.github/workflows/dojo-e2e-published.yml` runs the whole `dojo-e2e.yml`
matrix this way every Monday (and on manual dispatch). Each lane is
`continue-on-error`, writes its own table to the job summary and uploads a JSON
report; the final `report` job merges them into one
`lane | package | resolved | latest | pass/fail` table and fails if any lane failed.
