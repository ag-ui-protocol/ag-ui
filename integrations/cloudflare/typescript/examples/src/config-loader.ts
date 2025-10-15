/**
 * Configuration loader for Cloudflare agents
 *
 * Reads cloudflare.json and provides utilities for agent discovery
 * and dynamic route registration.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface AgentConfig {
  path: string;
  export: string;
  description: string;
  model: string;
}

export interface CloudflareConfig {
  dependencies: string[];
  agents: Record<string, AgentConfig>;
  env: string;
  server: {
    port: number;
    host: string;
  };
}

/**
 * Load cloudflare.json configuration
 */
export function loadConfig(): CloudflareConfig {
  const configPath = join(process.cwd(), "cloudflare.json");
  const configContent = readFileSync(configPath, "utf-8");
  return JSON.parse(configContent);
}

/**
 * Get list of all agent names
 */
export function getAgentNames(config: CloudflareConfig): string[] {
  return Object.keys(config.agents);
}

/**
 * Get agent configuration by name
 */
export function getAgentConfig(config: CloudflareConfig, agentName: string): AgentConfig | undefined {
  return config.agents[agentName];
}

/**
 * Dynamically import an agent getter function
 */
export async function loadAgentGetter(agentName: string, config: CloudflareConfig) {
  const agentConfig = getAgentConfig(config, agentName);
  if (!agentConfig) {
    throw new Error(`Agent "${agentName}" not found in cloudflare.json`);
  }

  // Import the module
  const modulePath = agentConfig.path.replace("./src/", "../").replace(".ts", ".js");
  const module = await import(modulePath);

  // Get the getter function
  const getterFunction = module[agentConfig.export];
  if (typeof getterFunction !== "function") {
    throw new Error(`Export "${agentConfig.export}" is not a function in ${agentConfig.path}`);
  }

  return getterFunction;
}
