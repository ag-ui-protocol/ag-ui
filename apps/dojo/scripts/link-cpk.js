#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const cpkPath = process.argv[2];
if (!cpkPath) {
  console.error('Usage: node link-cpk.js <cpk-path>');
  process.exit(1);
}

if (!fs.existsSync(cpkPath)) {
  console.error(`copilot kit repo path ${cpkPath} does not exist`);
  process.exit(1);
}


const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: __dirname }).trim();
const dojoDir = path.join(gitRoot, 'apps/dojo');
const cpkPackageDir = path.join(cpkPath, 'CopilotKit', 'packages');
const relative = `./${path.relative(dojoDir, cpkPackageDir)}`;

function linkCopilotKit() {
  const pkgPath = path.join(dojoDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const packages = Object.keys(pkg.dependencies).filter(pkg => pkg.startsWith('@copilotkit/'));

  success = true;
  packages.forEach(packageName => {
    const packageFolderName = packageName.replace('@copilotkit/', '');

    if (!fs.existsSync(path.join(cpkPackageDir, packageFolderName))) {
      console.error(`Package ${packageName} does not exist in ${cpkPackageDir}!!`);
      success = false;
    }

    pkg.dependencies[packageName] = path.join(relative, packageFolderName);
  });



  if (!success) {
    console.error('One or more packages do not exist in the copilot kit repo!');
    process.exit(1);
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

}

linkCopilotKit();
