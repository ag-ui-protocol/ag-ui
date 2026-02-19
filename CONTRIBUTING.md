# Contributing to AG-UI

Thanks for checking out AG-UI! Whether you're here to fix a bug, ship a feature, improve the docs, or just figure out how things work—we're glad you're here.

Here's how to get involved:

---

## Have a Question or Ran Into Something?

Pick the right spot so we can help you faster:

- **Bugs / Feature Ideas** → [GitHub Issues](https://github.com/ag-ui-protocol/ag-ui/issues)
- **"How do I...?" / General Questions** → [GitHub Discussions](https://github.com/ag-ui-protocol/ag-ui/discussions)
- **Quick chats / casual stuff** → [Discord](https://discord.gg/Jd3FzfdJa8) → `#-💎-contributing`

---

## Want to Contribute Code?

First, an important plea:
**Please PLEASE reach out to us first before starting any significant work on new or existing features.**

We love community contributions! That said, we want to make sure we're all on the same page before you start.
Investing a lot of time and effort just to find out it doesn't align with the upstream project feels awful, and we don't want that to happen.
It also helps to make sure the work you're planning isn't already in progress.

As described below, please file an issue first: https://github.com/ag-ui-protocol/ag-ui/issues
Or, reach out to us on Discord: https://discord.gg/Jd3FzfdJa8

1. **Find Something to Work On**
   Browse open issues on [GitHub](https://github.com/ag-ui-protocol/ag-ui/issues).
   Got your own idea? Open an issue first so we can start the discussion.

2. **Ask to Be Assigned**
   Comment on the issue and tag a code owner:
   → [Code Owners](https://github.com/ag-ui-protocol/ag-ui/blob/main/.github/CODEOWNERS)

3. **Get on the Roadmap**
   Once approved, you'll be assigned the issue, and it'll get added to our [roadmap](https://github.com/orgs/ag-ui-protocol/projects/1).

4. **Coordinate With Others**
   - If you're collaborating or need feedback, start a thread in `#-💎-contributing` on Discord
   - Or just DM the assignee directly

5. **Open a Pull Request**
   - When you're ready, submit your PR
   - In the description, include: `Fixes #<issue-number>`
     (This links your PR to the issue and closes it automatically)

6. **Review & Merge**
   - A maintainer will review your code and leave comments if needed
   - Once it's approved, we'll merge it and move the issue to "done."

**NOTE:** All community integrations (ie, .NET, Golang SDK, etc.) will need to be maintained by the community

---

## Step-by-Step Guide to Adding an Integration PR

This guide walks you through everything needed to submit an integration PR to AG-UI. It covers adding the integration code, examples, dojo configuration, end-to-end tests, and CI setup.

Use existing integrations in `integrations/` (e.g., `integrations/adk-middleware/` or `integrations/langgraph/`) as reference implementations throughout.

### Step 1: Add Your Integration Folder

Your integration code goes inside the `integrations/` folder, under a subfolder named after your integration (e.g., `integrations/my-framework/`).

- **Language subfolder** — Organize by language. For example, if your integration is in Python, place it under `integrations/my-framework/python/`. If it supports multiple languages (e.g., Python and Rust), use separate subfolders like `python/` and `rust/`.
- **Examples subfolder** — Include an `examples/` directory inside your language folder. The dojo examples must live here (e.g., `integrations/my-framework/python/examples/`).
- **TypeScript client folder (required)** — No matter what language the integration is in, you must also include a `typescript/` folder. This contains the TypeScript client code that re-exports the HTTP agent. You can copy this from an existing integration like `integrations/adk-middleware/typescript/` as a reference. It includes a `package.json`, TypeScript config, and the client code itself.

**Example structure:**
```
integrations/my-framework/
├── python/
│   ├── examples/          # Dojo examples live here
│   │   ├── pyproject.toml
│   │   └── ...
│   ├── pyproject.toml     # Integration package
│   └── ...
└── typescript/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── index.ts       # Re-exports the HTTP agent
```

### Step 2: Register Your Integration in the Dojo

You need to update three files inside `apps/dojo/src/` to make the dojo aware of your integration:

- **`agents.ts`** — Add an entry for your integration. The name you choose is important because it must match exactly in the other files. If your framework has multiple ways to run it (e.g., LangGraph has both a Python and a FastAPI version), each variant gets its own separate entry.
- **`menu.ts`** — Add your integration to the sidebar menu. The name and ID here must match what you used in `agents.ts`. Each entry also defines which features it supports (e.g., `agentic_chat`, `human_in_the_loop`, `agentic_generative_ui`). This file is the single source of truth for integration configuration.
- **`env.ts`** — Define the environment variable for your agent's hosted URL (one per agent). This is how the dojo knows where to reach your agent at runtime. The default should match whatever host/port your example code uses.

### Step 3: Configure the Agent Mapping

Each entry in `agents.ts` contains a mapping of feature keys. This is typically a one-to-one mapping where each key corresponds to one agent. For most integrations, this is simple — one feature maps to one agent name. If your framework handles multiple agents talking together, there may be multiple agents listed, but each still gets its own entry.

### Step 4: Set Up Environment Variables

Your example code must:

- **Bind to host `0.0.0.0`** (or be overridable via the `HOST` environment variable)
- **Respect the `PORT` environment variable** — when the dojo sets a specific port, your agent must bind to that exact port

The port values defined in `env.ts` must match the URLs configured in `agents.ts`. If they don't line up, the dojo won't be able to find your agent.

### Step 5: Add Dojo Scripts

Add entries for your integration in the dojo script configuration at `apps/dojo/scripts/`. There are two scripts to update:

- **`prep-dojo-everything.js`** — This is the "prepare" command. It installs dependencies and builds your module (e.g., `pnpm install`, `uv sync`, `poetry install`). It does **not** start any servers.
- **`run-dojo-everything.js`** — This is the "run" command. It starts your integration's agent server.

Each script entry includes:
- The **name** for logging
- The **working directory** (pointing into your `integrations/` examples folder)
- Any **environment variables** you want to pass in (like `PORT`)

The service names in these scripts **must match** the names used in `agents.ts`.

At this point, you should be able to spin up the dojo locally and see your integration working.

### Step 6: Add End-to-End Tests

Every feature listed in your sidebar entry (in `menu.ts`) needs a corresponding end-to-end test. **Without tests, your PR will not be considered ready.**

- **Create a test folder** for your integration inside `apps/dojo/e2e/tests/` (e.g., `apps/dojo/e2e/tests/myFrameworkTests/`). Each feature you support gets its own spec file inside this folder.
- **Reuse shared helpers** — There are shared helper fixtures in `apps/dojo/e2e/featurePages/` (feature pages, agentic chat page helpers) that you can reuse. Most tests should look very similar across frameworks. Unless your framework differs significantly (e.g., LangGraph uses interrupts for human-in-the-loop instead of tool-call-based HITL), you should be able to reuse the standard test patterns.
- **Run tests locally** before submitting your PR. The dojo uses a production build by default (`pnpm run start`), which pre-compiles pages so tests load faster. You can use `pnpm run dev` with the `--only` flag if you just want to test the dojo web app without compiling everything.

### Step 7: Add CI Configuration

The end-to-end tests need to run in CI as well. Update the GitHub Actions workflow file at `.github/workflows/dojo-e2e.yml`:

- **Add your integration to the test matrix** at the top of the workflow. This tells CI which test path to use (e.g., `tests/myFrameworkTests`).
- **Add a services section** that defines which services to build and run. This maps back to the `prep-dojo` and `run-dojo` scripts. The CI workflow uses a `wait-on` command to check that services are responsive (via TCP/HTTP) before running tests.

**Note:** Tests won't run by default on external PRs. The team will open a separate PR from within the repo to trigger CI, then merge the original contributor PR once tests pass.

### Step 8: Update CODEOWNERS

Update the `.github/CODEOWNERS` file so the `@ag-ui-protocol/copilotkit` team is listed as an owner for your integration path. For example:

```
integrations/my-framework @ag-ui-protocol/copilotkit @your-github-username
```

### Step 9 (Optional): Contributing a Community SDK

If you're adding a new language SDK (e.g., Go, Java, Kotlin, Ruby, Rust), place it in the `sdks/community/` folder. The team will add you as a code owner for that SDK so you can push changes without needing core team sign-off. Documentation for community SDKs also lives inside that SDK folder.

### Quick Reference Checklist

Use this checklist to verify your PR is complete before submitting:

- [ ] Integration folder added under `integrations/` with language subfolder + examples
- [ ] TypeScript client folder included (even for non-TS integrations)
- [ ] `agents.ts` updated with integration entry and feature mapping
- [ ] `menu.ts` updated with sidebar entry (name/ID matches `agents.ts`)
- [ ] `env.ts` updated with agent URL environment variable
- [ ] Example code binds to `0.0.0.0` and respects `HOST`/`PORT` env vars
- [ ] `prep-dojo-everything.js` and `run-dojo-everything.js` entries added with matching service names
- [ ] End-to-end test spec files added for every supported feature
- [ ] Tests pass locally
- [ ] CI workflow matrix updated in `.github/workflows/dojo-e2e.yml`
- [ ] `CODEOWNERS` updated with team instead of individual users

---

## Want to Contribute to the Docs?

Docs are part of the codebase and super valuable—thanks for helping improve them!

Here's how to contribute:

1. **Open an Issue First**
   - Open a [GitHub issue](https://github.com/ag-ui-protocol/ag-ui/issues) describing what you'd like to update or add.
   - Then comment and ask to be assigned.

2. **Submit a PR**
   - Once assigned, make your edits and open a pull request.
   - In the description, include: `Fixes #<issue-number>`
     (This links your PR to the issue and closes it automatically)

   - A maintainer will review it and merge if it looks good.

That's it! Simple and appreciated.

---

## That's It!

AG-UI is community-built, and every contribution helps shape where we go next.
Big thanks for being part of it!
