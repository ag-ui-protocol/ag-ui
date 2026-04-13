#!/usr/bin/env node
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const cpkPath = process.argv[2] || "./CopilotKit/packages";

if (!fs.existsSync(cpkPath)) {
  console.error(`CopilotKit packages path ${cpkPath} does not exist`);
  process.exit(1);
}

// Detect whether the CopilotKit repo uses the old v1/v2 split or the new flat structure.
const hasV1Subdir = fs.existsSync(path.join(cpkPath, "v1"));
const hasV2Subdir = fs.existsSync(path.join(cpkPath, "v2"));
const isOldStructure = hasV1Subdir && hasV2Subdir;

const namespaceDirs = {};
if (isOldStructure) {
  // Old CopilotKit structure: v1/ and v2/ subdirs
  namespaceDirs["@copilotkit/"] = path.join(cpkPath, "v1");
  namespaceDirs["@copilotkitnext/"] = path.join(cpkPath, "v2");
} else {
  // New flat structure (CopilotKit PR #3409): all packages under @copilotkit/
  namespaceDirs["@copilotkit/"] = cpkPath;
}

const gitRoot = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
  cwd: __dirname,
}).trim();
const dojoDir = path.join(gitRoot, "apps/dojo");

function linkCopilotKit() {
  const pkgPath = path.join(dojoDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  let success = true;

  for (const [prefix, pkgDir] of Object.entries(namespaceDirs)) {
    const relative = `./${path.relative(dojoDir, pkgDir)}`;
    const packages = Object.keys(pkg.dependencies).filter((dep) =>
      dep.startsWith(prefix),
    );

    packages.forEach((packageName) => {
      const folderName = packageName.replace(prefix, "");

      if (!fs.existsSync(path.join(pkgDir, folderName))) {
        console.error(
          `Package ${packageName} does not exist in ${pkgDir}`,
        );
        success = false;
        return;
      }

      pkg.dependencies[packageName] = path.join(relative, folderName);
    });
  }

  if (!success) {
    console.error("One or more packages do not exist in the CopilotKit repo!");
    process.exit(1);
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // Summary
  for (const [prefix, pkgDir] of Object.entries(namespaceDirs)) {
    const count = Object.keys(pkg.dependencies).filter((d) =>
      d.startsWith(prefix),
    ).length;
    console.log(`Linked ${count} ${prefix}* packages from ${pkgDir}`);
  }
}

linkCopilotKit();
