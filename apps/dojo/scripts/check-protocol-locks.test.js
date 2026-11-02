"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { lockedProtocolVersion, findProblems } = require("./check-protocol-locks.js");

const lock = (version) =>
  `version = 1\n\n[[package]]\nname = "ag-ui-protocol"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n`;

test("reads the locked ag-ui-protocol version", () => {
  assert.equal(lockedProtocolVersion(lock("1.0.0")), "1.0.0");
  assert.equal(lockedProtocolVersion('[[package]]\nname = "fastapi"\nversion = "0.1.0"\n'), null);
});

test("a 0.x lock fails unless it is listed", () => {
  assert.deepEqual(findProblems({ "a/uv.lock": lock("1.0.0") }, {}), []);
  assert.match(findProblems({ "a/uv.lock": lock("0.1.19") }, {})[0], /resolves ag-ui-protocol 0\.1\.19/);
  assert.deepEqual(findProblems({ "a/uv.lock": lock("0.1.19") }, { "a/uv.lock": "upstream pin" }), []);
});

test("a listed lock that moved to 1.0, or is gone, fails so the list stays honest", () => {
  assert.match(
    findProblems({ "a/uv.lock": lock("1.0.0") }, { "a/uv.lock": "upstream pin" })[0],
    /remove it from PRE_1_0_LOCKS/,
  );
  assert.match(findProblems({}, { "a/uv.lock": "upstream pin" })[0], /does not exist/);
});

test("locks without ag-ui-protocol are ignored", () => {
  assert.deepEqual(findProblems({ "b/uv.lock": '[[package]]\nname = "x"\nversion = "0.1"\n' }, {}), []);
});
