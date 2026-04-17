const path = require("path");
const fs = require("fs");

/**
 * When COPILOTKIT_LOCAL=1, rewrites @copilotkit/* dependencies to link against
 * locally-built packages from the sibling CopilotKit repo.
 *
 * When A2UI_LOCAL=1, rewrites @a2ui/* dependencies to link against
 * locally-built packages from the sibling A2UI repo.
 *
 * Usage:
 *   COPILOTKIT_LOCAL=1 A2UI_LOCAL=1 pnpm install   # link both
 *   pnpm install                                     # install from npm (default)
 *
 * Expects:
 *   /some/path/ag-ui/       (this repo)
 *   /some/path/CopilotKit/  (sibling CopilotKit repo)
 *   /some/path/A2UI/        (sibling A2UI repo)
 */

const COPILOTKIT_ROOT = path.resolve(__dirname, "..", "CopilotKit");
const A2UI_ROOT = path.resolve(__dirname, "..", "A2UI");

// --- A2UI package mapping ---

/** Maps @a2ui/* package names to their local directories within the A2UI repo. */
const A2UI_PACKAGES = {
  "@a2ui/web_core": "renderers/web_core",
  "@a2ui/react": "renderers/react",
};

// --- CopilotKit helpers ---

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

// --- Hook ---

function readPackage(pkg) {
  // Rewrite @a2ui/* deps to local links when A2UI_LOCAL=1
  if (process.env.A2UI_LOCAL) {
    for (const [dep, relPath] of Object.entries(A2UI_PACKAGES)) {
      if (pkg.dependencies && pkg.dependencies[dep]) {
        const localPath = path.join(A2UI_ROOT, relPath);
        if (fs.existsSync(localPath)) {
          pkg.dependencies[dep] = `link:${localPath}`;
        }
      }
    }
  }

  // Rewrite @copilotkit/* deps to local links when COPILOTKIT_LOCAL=1
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
