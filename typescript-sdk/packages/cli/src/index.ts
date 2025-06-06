#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import { spawn } from "child_process";

const program = new Command();

// Dark purple color
const PURPLE = "\x1b[35m";
const RESET = "\x1b[0m";

function displayBanner() {
  const banner = `
${PURPLE}   █████╗  ██████╗       ██╗   ██╗ ██╗
  ██╔══██╗██╔════╝       ██║   ██║ ██║
  ███████║██║  ███╗█████╗██║   ██║ ██║
  ██╔══██║██║   ██║╚════╝██║   ██║ ██║
  ██║  ██║╚██████╔╝      ╚██████╔╝ ██║
  ╚═╝  ╚═╝ ╚═════╝        ╚═════╝  ╚═╝
${RESET}
  Agent User Interactivity Protocol
`;
  console.log(banner);
}

async function createProject() {
  displayBanner();

  console.log("\n~ Let's get you started with AG-UI, just a few questions ~\n");

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "client",
      message: "What client do you want to use?",
      choices: ["CopilotKit/NextJs", new inquirer.Separator("(Other clients coming soon)")],
    },
  ]);

  console.log(`\nSelected client: ${answers.client}`);
  console.log("Initializing your project...\n");

  // Run copilotkit init
  const copilotkit = spawn("npx", ["copilotkit", "init"], {
    stdio: "inherit",
    shell: true,
  });

  copilotkit.on("close", (code) => {
    if (code === 0) {
      console.log("\n✅ Project created successfully!");
    } else {
      console.log("\n❌ Project creation failed.");
    }
  });
}

program.name("ag-ui-create").description("AG-UI CLI").version("0.0.1-alpha.0");

program.action(async () => {
  await createProject();
});

program.parse();
