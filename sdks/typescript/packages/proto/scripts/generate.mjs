import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = "src/generated";
const protoDir = "src/proto";
const binDir = join(packageDir, "node_modules", ".bin");
const plugin = join(
  binDir,
  process.platform === "win32" ? "protoc-gen-ts_proto.CMD" : "protoc-gen-ts_proto",
);
const protoc = join(packageDir, "node_modules", "@protobuf-ts", "protoc", "protoc.js");

mkdirSync(join(packageDir, generatedDir), { recursive: true });

const protoFiles = readdirSync(join(packageDir, protoDir))
  .filter((file) => file.endsWith(".proto"))
  .sort()
  .map((file) => join(protoDir, file));

const result = spawnSync(
  process.execPath,
  [
    protoc,
    `--plugin=protoc-gen-ts_proto=${plugin}`,
    `--ts_proto_out=${generatedDir}`,
    "--ts_proto_opt=esModuleInterop=true,outputJsonMethods=false,outputClientImpl=false",
    "-I",
    protoDir,
    ...protoFiles,
  ],
  {
    cwd: packageDir,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
