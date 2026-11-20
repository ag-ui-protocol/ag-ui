import assert from "node:assert/strict";

// Returns how many cases document a difference: `verdicts` where the two
// sides accept differently, `values` where both accept and normalize differently.
export function verifyCases(cases, rust, schemas) {
  const failures = [];
  const differences = { verdicts: 0, values: 0 };
  assert.equal(rust.length, cases.length);
  assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
  for (const [index, fixture] of cases.entries()) {
    try {
      const parsed = schemas[fixture.kind].safeParse(fixture.input);
      const actual = rust[index];
      assert.equal(actual.name, fixture.name);
      assert.equal(parsed.success, fixture.accepted, "official schema verdict");
      const upstream = parsed.success ? JSON.parse(JSON.stringify(parsed.data)) : undefined;
      if (Object.hasOwn(fixture, "rustAccepted")) {
        // A documented acceptance difference pins both verdicts, and the value
        // of whichever side accepted.
        assert(fixture.difference?.length, "an acceptance difference needs an explanation");
        assert.notEqual(fixture.rustAccepted, fixture.accepted, "rustAccepted repeats the official verdict");
        assert.equal(actual.accepted, fixture.rustAccepted, "documented Rust verdict changed");
        if (parsed.success) assert.deepEqual(upstream, fixture.upstreamValue, "upstream representation changed");
        else assert.deepEqual(actual.value, fixture.rustValue, "documented Rust representation changed");
        differences.verdicts += 1;
        continue;
      }
      assert.equal(actual.accepted, parsed.success, "Rust acceptance differs from official schema");
      if (parsed.success) {
        if (Object.hasOwn(fixture, "rustValue")) {
          assert(fixture.difference?.length, "a representation difference needs an explanation");
          assert.deepEqual(upstream, fixture.upstreamValue, "upstream representation changed");
          assert.notDeepEqual(fixture.rustValue, fixture.upstreamValue);
          assert.deepEqual(actual.value, fixture.rustValue, "documented Rust representation changed");
          differences.values += 1;
        } else {
          assert.deepEqual(actual.value, upstream, "normalized wire values differ");
        }
      }
    } catch (error) {
      failures.push(`${fixture.name}: ${error.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  return differences;
}
