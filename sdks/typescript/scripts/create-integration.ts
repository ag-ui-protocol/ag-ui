#!/usr/bin/env node

const args = process.argv.slice(2);

const hasMiddleware = args.includes("--middleware");
const hasServer = args.includes("--server");

function showHelp() {
  console.log(`
Usage: pnpm create-integration [OPTIONS] <integration-name>

Create a new AG-UI integration

OPTIONS:
  --middleware    Create a middleware-based integration
  --server        Create a server-based integration

ARGUMENTS:
  <integration-name>    Name of the integration in kebab-case (e.g., my-integration)

EXAMPLES:
  pnpm create-integration --middleware my-integration
  pnpm create-integration --server my-api-integration
`);
}

if (!hasMiddleware && !hasServer) {
  showHelp();
  process.exit(1);
}

if (hasMiddleware && hasServer) {
  console.error("Error: Cannot specify both --middleware and --server");
  showHelp();
  process.exit(1);
}

// Get the integration name (should be after the flag)
const integrationName = args.find((arg) => !arg.startsWith("--"));

if (!integrationName) {
  console.error("Error: Integration name is required");
  showHelp();
  process.exit(1);
}

// Validate kebab-case format: lowercase letters, numbers, and hyphens only
// Must start with a letter, cannot start or end with hyphen, no consecutive hyphens
const kebabCaseRegex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

if (!kebabCaseRegex.test(integrationName)) {
  console.error(`Error: Integration name "${integrationName}" is not in valid kebab-case format`);
  console.error("Valid kebab-case examples: my-integration, api-client, my-api-123");
  showHelp();
  process.exit(1);
}

if (hasMiddleware) {
  console.log(`Creating middleware-based integration: ${integrationName}`);

  const { execSync } = require("child_process");
  const path = require("path");
  const fs = require("fs");

  const integrationsDir = path.join(__dirname, "integrations");
  const sourceDir = path.join(integrationsDir, "middleware-starter");
  const targetDir = path.join(integrationsDir, integrationName);

  // Check if source directory exists
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Template directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Check if target directory already exists
  if (fs.existsSync(targetDir)) {
    console.error(`Error: Integration directory already exists: ${targetDir}`);
    process.exit(1);
  }

  try {
    console.log(
      `Copying template from integrations/middleware-starter to integrations/${integrationName}...`,
    );
    execSync(`cp -r "${sourceDir}" "${targetDir}"`, { stdio: "inherit" });
    console.log(`✓ Created integration at integrations/${integrationName}`);

    // Update package.json
    const packageJsonPath = path.join(targetDir, "package.json");
    console.log(`Updating package.json...`);

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.name = `@ag-ui/${integrationName}`;

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
    console.log(`✓ Updated package name to @ag-ui/${integrationName}`);

    // Convert kebab-case to PascalCase
    const pascalCaseName = integrationName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
    const agentClassName = `${pascalCaseName}Agent`;

    // Update src/index.ts
    const indexPath = path.join(targetDir, "src", "index.ts");
    console.log(`Updating src/index.ts...`);

    let indexContent = fs.readFileSync(indexPath, "utf8");
    indexContent = indexContent.replace(
      /MiddlewareStarterAgent/g,
      agentClassName
    );

    fs.writeFileSync(indexPath, indexContent);
    console.log(`✓ Updated class name to ${agentClassName}`);

    // Update apps/dojo/src/menu.ts
    const menuPath = path.join(__dirname, "apps", "dojo", "src", "menu.ts");
    console.log(`Updating apps/dojo/src/menu.ts...`);

    let menuContent = fs.readFileSync(menuPath, "utf8");

    const newIntegration = `  {
    id: "${integrationName}",
    name: "${pascalCaseName}",
    features: ["agentic_chat"],
  },\n`;

    // Find the menuIntegrations array and prepend the new integration
    menuContent = menuContent.replace(
      /(export const menuIntegrations: MenuIntegrationConfig\[\] = \[\n)/,
      `$1${newIntegration}`
    );

    fs.writeFileSync(menuPath, menuContent);
    console.log(`✓ Registered integration in dojo menu`);

    // Update apps/dojo/src/agents.ts
    const agentsPath = path.join(__dirname, "apps", "dojo", "src", "agents.ts");
    console.log(`Updating apps/dojo/src/agents.ts...`);

    let agentsContent = fs.readFileSync(agentsPath, "utf8");

    // Add import statement at the top
    const importStatement = `import { ${agentClassName} } from "@ag-ui/${integrationName}";\n`;
    agentsContent = importStatement + agentsContent;

    const newAgentIntegration = `  {
    id: "${integrationName}",
    agents: async () => {
      return {
        agentic_chat: new ${agentClassName}(),
      }
    },
  },\n`;

    // Find the agentsIntegrations array and prepend the new integration
    agentsContent = agentsContent.replace(
      /(export const agentsIntegrations: AgentIntegrationConfig\[\] = \[\n)/,
      `$1${newAgentIntegration}`
    );

    fs.writeFileSync(agentsPath, agentsContent);
    console.log(`✓ Registered agent in dojo agents`);

    // Update apps/dojo/package.json
    const dojoPackageJsonPath = path.join(__dirname, "apps", "dojo", "package.json");
    console.log(`Updating apps/dojo/package.json...`);

    const dojoPackageJson = JSON.parse(fs.readFileSync(dojoPackageJsonPath, "utf8"));

    // Add the new integration as a dependency at the beginning
    const newDependencies = {
      [`@ag-ui/${integrationName}`]: "workspace:*",
      ...dojoPackageJson.dependencies
    };
    dojoPackageJson.dependencies = newDependencies;

    fs.writeFileSync(dojoPackageJsonPath, JSON.stringify(dojoPackageJson, null, 2) + "\n");
    console.log(`✓ Added @ag-ui/${integrationName} to dojo dependencies`);
  } catch (error) {
    console.error("Error creating integration:", error);
    process.exit(1);
  }
}

if (hasServer) {
  console.log(`Creating server-based integration: ${integrationName}`);

  const { execSync } = require("child_process");
  const path = require("path");
  const fs = require("fs");

  const integrationsDir = path.join(__dirname, "integrations");
  const sourceDir = path.join(integrationsDir, "server-starter");
  const targetDir = path.join(integrationsDir, integrationName);

  // Check if source directory exists
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Template directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Check if target directory already exists
  if (fs.existsSync(targetDir)) {
    console.error(`Error: Integration directory already exists: ${targetDir}`);
    process.exit(1);
  }

  try {
    console.log(
      `Copying template from integrations/server-starter to integrations/${integrationName}...`,
    );
    execSync(`cp -r "${sourceDir}" "${targetDir}"`, { stdio: "inherit" });
    console.log(`✓ Created integration at integrations/${integrationName}`);

    // Update package.json
    const packageJsonPath = path.join(targetDir, "package.json");
    console.log(`Updating package.json...`);

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.name = `@ag-ui/${integrationName}`;

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
    console.log(`✓ Updated package name to @ag-ui/${integrationName}`);

    // Convert kebab-case to PascalCase
    const pascalCaseName = integrationName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
    const agentClassName = `${pascalCaseName}Agent`;

    // Update src/index.ts
    const indexPath = path.join(targetDir, "src", "index.ts");
    console.log(`Updating src/index.ts...`);

    let indexContent = fs.readFileSync(indexPath, "utf8");
    indexContent = indexContent.replace(
      /ServerStarterAgent/g,
      agentClassName
    );

    fs.writeFileSync(indexPath, indexContent);
    console.log(`✓ Updated class name to ${agentClassName}`);

    // Update apps/dojo/src/menu.ts
    const menuPath = path.join(__dirname, "apps", "dojo", "src", "menu.ts");
    console.log(`Updating apps/dojo/src/menu.ts...`);

    let menuContent = fs.readFileSync(menuPath, "utf8");

    const newIntegration = `  {
    id: "${integrationName}",
    name: "${pascalCaseName}",
    features: ["agentic_chat"],
  },\n`;

    // Find the menuIntegrations array and prepend the new integration
    menuContent = menuContent.replace(
      /(export const menuIntegrations: MenuIntegrationConfig\[\] = \[\n)/,
      `$1${newIntegration}`
    );

    fs.writeFileSync(menuPath, menuContent);
    console.log(`✓ Registered integration in dojo menu`);

    // Update apps/dojo/src/agents.ts
    const agentsPath = path.join(__dirname, "apps", "dojo", "src", "agents.ts");
    console.log(`Updating apps/dojo/src/agents.ts...`);

    let agentsContent = fs.readFileSync(agentsPath, "utf8");

    // Add import statement at the top
    const importStatement = `import { ${agentClassName} } from "@ag-ui/${integrationName}";\n`;
    agentsContent = importStatement + agentsContent;

    const newAgentIntegration = `  {
    id: "${integrationName}",
    agents: async () => {
      return {
        agentic_chat: new ${agentClassName}({ url: "http://localhost:8000" }),
      }
    },
  },\n`;

    // Find the agentsIntegrations array and prepend the new integration
    agentsContent = agentsContent.replace(
      /(export const agentsIntegrations: AgentIntegrationConfig\[\] = \[\n)/,
      `$1${newAgentIntegration}`
    );

    fs.writeFileSync(agentsPath, agentsContent);
    console.log(`✓ Registered agent in dojo agents`);

    // Update apps/dojo/package.json
    const dojoPackageJsonPath = path.join(__dirname, "apps", "dojo", "package.json");
    console.log(`Updating apps/dojo/package.json...`);

    const dojoPackageJson = JSON.parse(fs.readFileSync(dojoPackageJsonPath, "utf8"));

    // Add the new integration as a dependency at the beginning
    const newDependencies = {
      [`@ag-ui/${integrationName}`]: "workspace:*",
      ...dojoPackageJson.dependencies
    };
    dojoPackageJson.dependencies = newDependencies;

    fs.writeFileSync(dojoPackageJsonPath, JSON.stringify(dojoPackageJson, null, 2) + "\n");
    console.log(`✓ Added @ag-ui/${integrationName} to dojo dependencies`);
  } catch (error) {
    console.error("Error creating integration:", error);
    process.exit(1);
  }
}
