import { agentRegistry } from "./registry";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import inquirer from "inquirer";

export async function loadAgentFromCLI() {
  // 1. Parse CLI args
  const argv = yargs(hideBin(process.argv))
    .option("agent", { type: "string", describe: "Agent/framework to use" })
    // Do not add all possible config fields as yargs options; we'll check argv directly
    .help()
    .parseSync();

  // 2. Determine agent type
  let agentType = argv.agent;
  if (!agentType) {
    agentType = (
      await inquirer.prompt([
        {
          type: "list",
          name: "agentType",
          message: "Select an agent/framework:",
          choices: Object.keys(agentRegistry).map((key) => ({
            name: agentRegistry[key].label,
            value: key,
          })),
        },
      ])
    ).agentType;
  }

  const agentEntry = agentRegistry[agentType as keyof typeof agentRegistry];
  if (!agentEntry) throw new Error(`Unknown agent type: ${agentType}`);

  // 3. Gather config (from CLI args or prompt for missing)
  const config: Record<string, any> = {};
  for (const field of agentEntry.required) {
    if (argv[field]) {
      config[field] = argv[field];
    } else {
      config[field] = (
        await inquirer.prompt([
          { type: "input", name: field, message: `Enter value for ${field}:` },
        ])
      )[field];
    }
  }
  // Optionally gather optional fields if provided via CLI
  if (agentEntry.optional) {
    for (const field of agentEntry.optional) {
      if (argv[field]) {
        config[field] = argv[field];
      }
    }
  }

  // 4. Instantiate agent
  const agent = new agentEntry.AgentClass(config);
  return agent;
} 