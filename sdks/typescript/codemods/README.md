# @ag-ui/core codemods

Automated transforms for upgrading code that depends on `@ag-ui/core`.

---

## 0.1.0-schemas-to-subpath

**What it does.** Moves every `*Schema` import (and `EventSchemas`, the only "Schemas" plural export) from `@ag-ui/core` to the new `@ag-ui/core/schemas` subpath introduced in 0.1.0. If a file already has an import from `@ag-ui/core/schemas`, the moved specifiers are merged into it rather than creating a duplicate declaration. Type-only imports (`import type { ... }`) are preserved on the appropriate side. The transform is idempotent — running it twice produces the same output.

**How to run it.**

```bash
npx jscodeshift -t https://raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/sdks/typescript/codemods/0.1.0-schemas-to-subpath.ts \
  --parser=tsx \
  --extensions=ts,tsx \
  src/
```

To do a dry run (print changes without writing):

```bash
npx jscodeshift --dry --print \
  -t https://raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/sdks/typescript/codemods/0.1.0-schemas-to-subpath.ts \
  --parser=tsx \
  --extensions=ts,tsx \
  src/
```

**What it does NOT do.**

- It does not add `zod` to your `package.json`. After running the codemod, run `npm install zod` (or `pnpm add zod` / `yarn add zod`) if any file imports from `@ag-ui/core/schemas`.
- It does not update the `@ag-ui/core` version constraint in `package.json`. Update it to `^0.1.0` manually.

**Recognized schema names.**

The transform uses two complementary heuristics:

1. Any imported name that ends with `"Schema"` is moved (e.g. `UserMessageSchema`, `AgentCapabilitiesSchema`).
2. The name `EventSchemas` is explicitly matched (the only "Schemas" plural export).

The curated list in `SCHEMA_NAMES` inside the transform source mirrors the full public schema surface of `@ag-ui/core/schemas`. Both heuristics are applied, so unknown future schema additions (if they follow the naming convention) are also covered.

**Known limitations.**

- **Aliased imports** — `import { UserMessageSchema as MyAlias } from "@ag-ui/core"` is handled correctly: the specifier is moved based on the *imported* name (`UserMessageSchema`), and the local alias (`MyAlias`) is preserved in the new declaration. However, if you alias a schema name to something that does *not* end with `"Schema"`, the heuristic will still catch it because the imported name is used for detection, not the local alias.
- **Re-exports** — `export { UserMessageSchema } from "@ag-ui/core"` is not handled; only `import` declarations are transformed. Re-export-from syntax will need to be updated manually.
- **Dynamic imports** — `import("@ag-ui/core")` and `require("@ag-ui/core")` calls are not transformed; only static `import` declarations are handled.

---

For more context, see the [0.1.0 migration guide](https://docs.ag-ui.com/sdk/js/core/migration-0-1-0).
