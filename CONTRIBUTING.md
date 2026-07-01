# Contributing to AG-UI

Thanks for checking out AG-UI! Whether you're here to fix a bug, ship a feature, improve the docs, or just figure out how things work—we're glad you're here.

Here's how to get involved:

---

## Have a Question or Ran Into Something?

Pick the right spot so we can help you faster:

- **I want to contribute [Fixes / Feature Requests]** → [GitHub Issues](https://github.com/ag-ui-protocol/ag-ui/issues)
- **"How do I...?"** → [Discord](https://discord.gg/Jd3FzfdJa8) → `#-💎-contributing`
- **Introduce Yourself** → [Discord](https://discord.gg/Jd3FzfdJa8) → `🤝-intro`

---

## Want to Contribute Code?

First, an important plea: **Please PLEASE reach out to us first before starting any significant work on new or existing features.**

We love community contributions! That said, we want to make sure we're all on the same page before you start. Investing a lot of time and effort just to find out it doesn't align with the upstream project feels awful, and we don't want that to happen. It also helps to make sure the work you're planning isn't already in progress.

If you've confirmed the work hasn't been started yet, please file an issue first: <https://github.com/ag-ui-protocol/ag-ui/issues>

1. **Find Something to Work On** Browse open issues on [GitHub](https://github.com/ag-ui-protocol/ag-ui/issues). Got your own idea? Open an issue first so we can start the discussion.

2. **Ask to Be Assigned** Comment on the issue and tag a code owner:
→ [Code Owners](https://github.com/ag-ui-protocol/ag-ui/blob/main/.github/CODEOWNERS)

3. **Get on the Roadmap** Once approved, you'll be assigned the issue, and it'll get added to our [roadmap](https://github.com/orgs/ag-ui-protocol/projects/1).

4. **Coordinate With Others**
   - If you're collaborating or need feedback, start a thread in `#-💎-contributing` on Discord
   - Or just DM the assignee directly

5. **Open a Pull Request**
   - When you're ready, submit your PR
   - In the description, include: `Fixes #<issue-number>` (This links your PR to the issue and closes it automatically)

6. **Review & Merge**
   - A maintainer will review your code and leave comments if needed
   - Once it's approved, we'll merge it and move the issue to "done"

---

## Building a Community Integration

Community integrations (framework adapters, language bindings, runtime connectors, etc.) are the heart of the AG-UI ecosystem. The protocol is only as useful as the agents, frameworks, and tools that speak it—and that's where you come in.

### Where Integrations Live

**Community integrations are owned, hosted, and maintained by their authors in their own repositories.** This keeps you in control of your release cadence, your dependency choices, your issue tracker, and your roadmap. You ship when you're ready, version how you want, and respond to your own users directly.

The AG-UI repo's job is to make your integration discoverable—not to host its source. Once your integration is working and stable, you submit a small PR here that adds a pointer to it (name, description, link to your repo, supported features, language/runtime). That's it. No code, no examples, no CI plumbing in this repo.

### What Owning It Means

Listing your integration here means putting your name on it. Users will find your repo through AG-UI, try it out, and form their first impression of the protocol through your code. That's a real responsibility, and we ask you to take it seriously:

- **You're the maintainer.** Issues, bug reports, security questions, and PRs from users land in your repo. You triage them. The AG-UI team isn't on call for your integration.
- **The bar is high.** Listed integrations should feel production-grade—clean code, working examples, real documentation, a license, and a clear story for how someone gets from zero to a running agent. If it feels like a weekend hack, it's not ready to be listed yet.
- **It has to work against the dojo.** The [AG-UI dojo](https://github.com/ag-ui-protocol/ag-ui/tree/main/apps/dojo) is how we (and your users) verify that an integration actually implements the protocol correctly. Your integration must run against the dojo and pass the feature tests for everything you claim to support. If you list `agentic_chat` and `human_in_the_loop` in your registry entry, both need to work end-to-end in the dojo.
- **You keep it current.** AG-UI evolves. When the protocol or core SDKs change, you're expected to keep up within a reasonable window. Stale integrations confuse users and reflect badly on the whole ecosystem.

None of this is meant to scare anyone off—we want as many integrations as possible. But "listed on AG-UI" should mean something, and the only way it does is if every integration behind that link clears the bar.

### Why This Setup

A few reasons this works better for everyone:

- **You own the release cycle.** No waiting on AG-UI maintainers to cut a release when you fix a bug or add a feature.
- **Your stack, your rules.** Build your integration with the tooling, language version, and dependencies that make sense for your framework's community.
- **Tighter feedback loops.** Issues and PRs from your users land in your repo, where you're already paying attention.
- **The protocol stays lean.** AG-UI itself can focus on the spec and core SDKs without taking on the maintenance load of every downstream integration.

### How to Get Started

1. **Build it in your own repo.** Use the [AG-UI spec](https://github.com/ag-ui-protocol/ag-ui) and existing integrations as reference. The [Discord `#-💎-contributing` channel](https://discord.gg/Jd3FzfdJa8) is the best place to ask questions while you build.

2. **Validate it against the dojo.** Spin up the dojo locally, point it at your integration, and confirm every feature you plan to claim actually works. This is the single best signal—both for you and for us—that the integration is real.

3. **Polish before you list.** README with quickstart, working example, license, version compatibility notes, issue tracker enabled. Treat your repo like a real open-source project, because it is one.

4. **Tell us about it.** Once it's stable and dojo-verified, open an issue on this repo titled `Integration listing: <your framework>`. Include:
   - Link to your repo
   - Short description (one or two sentences)
   - Language(s) and runtime(s) supported
   - Which AG-UI features your integration covers and confirmation they pass in the dojo
   - License

5. **Submit the listing PR.** After a maintainer gives the green light on the issue, open a PR adding your entry to the community integrations registry. Maintainers will review for fit, accuracy, and basic quality, then merge.

6. **Keep it alive.** If your integration goes dormant or breaks against newer AG-UI versions for an extended period, we may flag it as unmaintained in the registry or remove the listing. If life gets in the way, just let us know—we'd rather help find a co-maintainer than delist.

---

## Contributing a Community SDK

If you're adding a new language SDK (e.g., Go, Java, Kotlin, Ruby, Rust) rather than a framework integration, the same principle applies: **SDKs live in their author's repo**, and we link to them from this repo.

Open an issue describing the SDK you want to build so we can coordinate, then follow the same listing flow above once it's ready. Documentation for community SDKs lives alongside the SDK itself.

---

## Want to Contribute to the Docs?

Docs are part of the codebase and super valuable—thanks for helping improve them!

Here's how to contribute:

1. **Open an Issue First**
   - Open a [GitHub issue](https://github.com/ag-ui-protocol/ag-ui/issues) describing what you'd like to update or add.
   - Then comment and ask to be assigned.

2. **Submit a PR**
   - Once assigned, make your edits and open a pull request.
   - In the description, include: `Fixes #<issue-number>` (This links your PR to the issue and closes it automatically)
   - A maintainer will review it and merge if it looks good.

That's it! Simple and appreciated.

---

## That's It!

AG-UI is community-built, and every contribution helps shape where we go next. Big thanks for being part of it!
