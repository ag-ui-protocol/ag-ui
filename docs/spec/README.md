# Serving the specification at `ag-ui.com/spec`

Every schema file names its own web address in `$id`, and a tool that meets one
fetches that address to resolve it and any reference it makes. The address has
to serve the file. The shape chosen for the draft is the shape every frozen
version inherits, and frozen versions are permanent, so this layout is a
long-lived commitment rather than a deployment detail.

## What lives here

One folder per version holds both halves of that version:

```
/spec/1.0                       the readable specification (index.mdx)
/spec/1.0/basic/processing      a page
/spec/1.0/events/lifecycle      a page
/spec/1.0/schema.json           the machine-readable schema
```

Pages are `.mdx` files Mintlify renders. `schema.json` is a static file Mintlify
serves as-is, the same way it serves `/images/…`. They share a folder and must
never share a name — `spec/harness/publishing.test.ts` fails the build if a page
is ever named so that it would shadow a published file.

`schema.json` is written by the generator (`pnpm --filter @ag-ui/spec generate`)
as a byte-for-byte copy of `spec/1.0/schema.json`, the file the SDKs are
generated from. Editing it here does nothing: the spec suite's drift gate
compares the committed bytes against a fresh generation and fails on any
difference. Change `spec/1.0/schema.json` and regenerate.

## Frozen versions and the draft

A released version never changes. `spec/1.0` and `docs/spec/1.0` stay
published as they were frozen; `spec/harness/publishing.test.ts` pins each
frozen schema by digest (`FROZEN`), so an edit to one fails the build.

Changes for the next version go into the working draft:

```
spec/draft/                     schema, fixtures, conformance, proto freeze
docs/spec/draft/                the readable draft, served at /spec/draft
```

The draft is the whole specification — everything already decided plus what
is pending — not a list of differences. The docs site shows it in the
Specification tab's version dropdown as "1.1 (draft)", beside "1.0 (current)".

**The SDKs are generated from the latest frozen version, never from the
draft.** `PROTOCOL_VERSION` and the package manifests keep stating `1.0` until
the draft is cut, so what ships is always what was frozen. The draft is still
checked: the spec suite runs the schema, fixture and conformance tests against
it as a second vitest project. The draft never reaches the SDK emitters;
adapting them (including the hand-written .NET protobuf mappers) is part of
the cut. The generator only publishes the draft's own `schema.json` and
`schema.mdx` under `docs/spec/draft`.

### Making a change in the draft

1. Change `spec/draft/schema.json` and/or the pages under `docs/spec/draft`,
   with fixtures under `spec/draft/fixtures` or `spec/draft/conformance`.
2. Mark the new or changed section, field or rule with the badge, on its own
   line under the heading (inside a heading it would leak into the anchor):

   ```mdx
   import { Since } from "/snippets/since.mdx";

   #### `encryptedValueType`

   <Since version="1.1" pr="2888" />
   ```

   The badges stay when the draft is frozen, the way "added in version X"
   notes do, so they remain useful after the release.
3. Add an entry under "Changes in 1.1" in `docs/spec/draft/changelog.mdx`
   (major, minor or schema), linking the pull request and the section.
4. Run `pnpm --filter @ag-ui/spec generate`, then `pnpm --filter @ag-ui/spec test`.

Reviewers see the whole difference with
`git diff --no-index docs/spec/1.0 docs/spec/draft` (and the same for `spec/`).

Every draft page starts with `<DraftNotice />` from
`/snippets/draft-notice.mdx`; a new draft page must too.

### Cutting a version

Cutting is still manual; a script is tracked as follow-up work.

1. Copy `spec/draft` and `docs/spec/draft` to `spec/<version>` and
   `docs/spec/<version>`, rewrite `/spec/draft` to `/spec/<version>` (including
   `$id`), drop the draft notices, and turn "Changes in <version>" into the
   released changelog.
2. Point the generator (`SCHEMA_PATH`, `FREEZE_PATH`, `DOCS_SPEC_OUTPUT_DIR`),
   the harness default (`AGUI_SPEC_VERSION`), the vitest projects and the SDK
   tests that read `spec/<version>/fixtures` or `conformance` at the new folder.
3. Set the stated protocol version in the package manifests, and move the
   conformance "newer version" cases one minor up.
4. Add the new version's schema digest to `FROZEN`.
5. In `docs.json`, add the new version as `<version> (current)` with
   `default: true`, drop `(current)` from the previous one, and relabel the
   draft for the version after.
6. Reset the draft changelog's pending section.

## The Cloudflare configuration

`ag-ui.com` sits behind Cloudflare and redirects every path to
`docs.ag-ui.com`, preserving the path. That is right for every page and wrong
for the schema: a tool resolving `$id` must receive the file, not a redirect to
a different origin, and the schema's address must stay stable even if the docs
host changes.

Two rules carry `/spec/*`, and both live in the Cloudflare dashboard for the
`ag-ui.com` zone. **Owner: the CopilotKit team** — the zone is team-administered
rather than any one person's, so ask in the team channel for access.

### 1. Do not redirect `/spec/*` (Rules → Redirect Rules)

The existing apex redirect must skip `/spec/`. Amend its expression so it fires
only when the path is not under `/spec/`:

```
(http.host eq "ag-ui.com" and not starts_with(http.request.uri.path, "/spec/"))
```

`/spec/*` then falls through to the origin that serves the docs site, so both
the pages and the files are served at the apex without a hop.

### 2. Add the CORS header (Rules → Response Header Transform Rules)

Mintlify sends no cross-origin header, so a browser-based tool — an online
schema validator, a playground — cannot read the file. Add a response header
rule scoped to the schema files:

```
Expression:  (http.host eq "ag-ui.com" and starts_with(http.request.uri.path, "/spec/") and ends_with(http.request.uri.path, ".json"))
Set static:  Access-Control-Allow-Origin: *
```

`*` is correct here: these files are public, unauthenticated, and meant to be
read by anything.

### Content type

Mintlify serves `.json` as `application/json`. Confirm it rather than assume it
(step 3 below); if a future host does not, add `Content-Type: application/json`
to the same response header rule.

## Verifying by hand

No automated test watches Cloudflare — a test in this repository cannot see it,
and making every pull request depend on a live site would trade one silent
failure for a noisy one. Run these four commands after any change to the rules
above, and after any change of docs host:

```bash
# 1. The file is served directly, with no redirect on the way.
curl -sS -o /dev/null -w '%{http_code} %{num_redirects}\n' \
  https://ag-ui.com/spec/1.0/schema.json          # expect: 200 0
curl -sS -o /dev/null -w '%{http_code} %{num_redirects}\n' \
  https://ag-ui.com/spec/draft/schema.json        # expect: 200 0

# 2. It comes back as JSON, and it is THIS schema, not an older deployment.
curl -sS -D- -o /dev/null https://ag-ui.com/spec/1.0/schema.json \
  | grep -i '^content-type'                          # expect: application/json
curl -sS https://ag-ui.com/spec/1.0/schema.json | shasum -a 256
shasum -a 256 < spec/1.0/schema.json               # expect: the same digest
#   $id alone proves nothing here: it is stable across every deployment of the
#   draft, so a site serving last month's file states exactly the same address.

# 3. A browser on another origin may read it.
curl -sS -D- -o /dev/null -H 'Origin: https://example.com' \
  https://ag-ui.com/spec/1.0/schema.json \
  | grep -i '^access-control-allow-origin'           # expect: *

# 4. Pages still render, and everything outside /spec/ still redirects.
curl -sSL -o /dev/null -w '%{http_code}\n' https://ag-ui.com/spec/1.0
#                                                    expect: 200 — -L tolerated
#   in case the renderer answers the bare path with a redirect to the index
#   page. Either way the overview must come back; only 4xx/5xx is a failure.
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://ag-ui.com/introduction
                                                     # expect: 3xx → docs.ag-ui.com/introduction
```

The distinction in step 4 is the one to keep straight: a page may redirect (the
retired page addresses do, to their new homes under `basic/` and `events/`), a
`.json` address may never.
