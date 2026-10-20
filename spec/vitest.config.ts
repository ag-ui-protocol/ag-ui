import { mergeConfig } from "vitest/config";
import baseConfig from "../sdks/typescript/vitest.base";

/**
 * The checks that hold for any version folder: the schema is sound, the
 * fixtures and conformance corpus agree with it. They run once per folder.
 * Everything else — the generator, the SDK manifests, publishing — is about
 * what ships, and runs once, against the latest frozen version.
 */
const PER_VERSION = [
  "harness/schema.test.ts",
  "harness/fixtures.test.ts",
  "harness/conformance.test.ts",
  "harness/optional-null.test.ts",
];

export default mergeConfig(baseConfig, {
  test: {
    // The shared base sets passWithNoTests, which is right for a package that may
    // legitimately have none. Here it would mean a broken discovery glob or a
    // renamed harness file exits 0 with nothing checked at all, and CI merging on
    // the strength of it.
    passWithNoTests: false,
    // Three tests here — the determinism check, the schema compile, and the
    // published-copy comparison — each run the generator or compile every
    // definition, and each is the FIRST test in its file to touch that module
    // graph, so it also pays the cold import. Locally that is 70-130ms; on a
    // loaded CI runner it measured 4.6-5.5s and tripped vitest's 5s default,
    // failing the suite on timing rather than on anything it checks. The work
    // is genuinely long-running, which is the case the option exists for.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: "1.0", env: { AGUI_SPEC_VERSION: "1.0" } },
      },
      {
        // Not `extends`: vitest concatenates `include` when extending, which
        // would put the base's catch-all glob back and run everything twice.
        test: {
          name: "draft",
          globals: true,
          environment: "node",
          include: PER_VERSION,
          testTimeout: 30_000,
          env: { AGUI_SPEC_VERSION: "draft" },
        },
      },
    ],
  },
});
