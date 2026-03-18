const path = require("path");
const fs = require("fs");

/**
 * When COPILOTKIT_LOCAL=1, rewrites @copilotkit/* dependencies to link against
 * locally-built packages from the sibling CopilotKit repo.
 *
 * Usage:
 *   COPILOTKIT_LOCAL=1 pnpm install   # link to local packages
 *   pnpm install                       # install from npm (default)
 *
 * Expects:
 *   /some/path/ag-ui/       (this repo)
 *   /some/path/CopilotKit/  (sibling CopilotKit repo)
 */

const COPILOTKIT_ROOT = path.resolve(__dirname, "..", "CopilotKit");

function getCopilotKitNamespaceDirs() {
  const pkgDir = path.join(COPILOTKIT_ROOT, "packages");
  const hasV1 = fs.existsSync(path.join(pkgDir, "v1"));
  const hasV2 = fs.existsSync(path.join(pkgDir, "v2"));

  if (hasV1 && hasV2) {
    return {
      "@copilotkit/": path.join(pkgDir, "v1"),
      "@copilotkitnext/": path.join(pkgDir, "v2"),
    };
  }
  return {
    "@copilotkit/": pkgDir,
  };
}

function readPackage(pkg) {
  if (!process.env.COPILOTKIT_LOCAL) return pkg;

  const namespaceDirs = getCopilotKitNamespaceDirs();
  let hasCopilotKitDep = false;

  // Rewrite existing @copilotkit/* and @copilotkitnext/* deps to local links
  for (const [prefix, dir] of Object.entries(namespaceDirs)) {
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (dep.startsWith(prefix)) {
        hasCopilotKitDep = true;
        const folderName = dep.replace(prefix, "");
        const localPath = path.join(dir, folderName);
        if (fs.existsSync(localPath)) {
          pkg.dependencies[dep] = `link:${localPath}`;
        }
      }
    }
  }

  // Inject transitive @copilotkitnext/* deps that the linked packages need.
  // When @copilotkit/react-core is linked, its dist re-exports from
  // @copilotkitnext/react and @copilotkitnext/core, which must be resolvable
  // from the consuming workspace (not just from CopilotKit's node_modules).
  if (hasCopilotKitDep) {
    const v2Dir = namespaceDirs["@copilotkitnext/"];
    if (v2Dir && fs.existsSync(v2Dir)) {
      const v2Entries = fs.readdirSync(v2Dir).filter((d) => {
        try { return fs.statSync(path.join(v2Dir, d)).isDirectory(); }
        catch { return false; }
      });
      pkg.dependencies = pkg.dependencies || {};
      for (const entry of v2Entries) {
        const depName = `@copilotkitnext/${entry}`;
        if (!pkg.dependencies[depName]) {
          pkg.dependencies[depName] = `link:${path.join(v2Dir, entry)}`;
        }
      }
    }
  }

  return pkg;
}

module.exports = { hooks: { readPackage } };
