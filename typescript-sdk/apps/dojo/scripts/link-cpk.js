#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const dojoDir = path.join(gitRoot, 'typescript-sdk/apps/dojo');

function linkCopilotKit() {
  const pkgPath = path.join(dojoDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const packages = Object.keys(pkg.dependencies).filter(pkg => pkg.startsWith('@copilotkit/'));

  success = true;
  packages.forEach(pkg => {
    console.log(`Linking ${pkg}`);
    try {
      execSync(`pnpm link ${pkg}`, {cwd: dojoDir});
      console.log(`Linked ${pkg}`);
    } catch (e) {
      console.error(`Error linking ${pkg}: ${e}`);
      success = false;
    }

  });

  if (!success) {
    process.exit(1);
  }

}

linkCopilotKit();