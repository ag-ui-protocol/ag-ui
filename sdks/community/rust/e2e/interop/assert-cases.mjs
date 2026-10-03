import assert from "node:assert/strict";

export function verifyCases(cases, rust, schemas) {
  const failures = [];
  let differences = 0;
  assert.equal(rust.length, cases.length);
  assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
  for (const [index, fixture] of cases.entries()) {
    try {
      const parsed = schemas[fixture.kind].safeParse(fixture.input);
      const actual = rust[index];
      assert.equal(actual.name, fixture.name);
      assert.equal(parsed.success, fixture.accepted, "official schema verdict");
      assert.equal(actual.accepted, parsed.success, "Rust acceptance differs from official schema");
      if (parsed.success) {
        const upstream = JSON.parse(JSON.stringify(parsed.data));
        if (Object.hasOwn(fixture, "rustValue")) {
          assert(fixture.difference?.length, "a representation difference needs an explanation");
          assert.deepEqual(upstream, fixture.upstreamValue, "upstream representation changed");
          assert.notDeepEqual(fixture.rustValue, fixture.upstreamValue);
          assert.deepEqual(actual.value, fixture.rustValue, "documented Rust representation changed");
          differences += 1;
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
