const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const packageRoot = resolve(__dirname, "..");
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const protoc = join(packageRoot, "node_modules", ".bin", `protoc${binSuffix}`);
const tsProtoPlugin = join(packageRoot, "node_modules", ".bin", `protoc-gen-ts_proto${binSuffix}`);
const protoDir = join(packageRoot, "src", "proto");
const generatedDir = join(packageRoot, "src", "generated");

mkdirSync(generatedDir, { recursive: true });

const protoFiles = readdirSync(protoDir)
  .filter((name) => name.endsWith(".proto"))
  .map((name) => join(protoDir, name));

const result = spawnSync(
  protoc,
  [
    `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
    `--ts_proto_out=${generatedDir}`,
    "--ts_proto_opt=esModuleInterop=true,outputJsonMethods=false,outputClientImpl=false",
    "-I",
    protoDir,
    ...protoFiles,
  ],
  { shell: process.platform === "win32", stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
