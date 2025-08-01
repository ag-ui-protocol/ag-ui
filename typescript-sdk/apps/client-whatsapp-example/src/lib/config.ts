import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface ConfigData {
  phoneNumberId: string;
  accessToken: string;
  webhookSecret: string;
  verifyToken: string;
}

// File path for storing config (in production, use a proper database)
const CONFIG_FILE = join(process.cwd(), '.config.json');

// In-memory cache
let configCache: ConfigData | null = null;

function loadConfigFromFile(): ConfigData | null {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(data) as ConfigData;
      console.log("Config loaded from file");
      return config;
    }
  } catch (error) {
    console.error("Error loading config from file:", error);
  }
  return null;
}

function saveConfigToFile(config: ConfigData): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log("Config saved to file");
  } catch (error) {
    console.error("Error saving config to file:", error);
  }
}

export function getConfig(): ConfigData | null {
  // First try cache
  if (configCache) {
    console.log("Config found in cache");
    return configCache;
  }

  // Try loading from file
  const fileConfig = loadConfigFromFile();
  if (fileConfig) {
    configCache = fileConfig;
    return fileConfig;
  }

  // Fallback to environment variables
  const envConfig = {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  };

  if (envConfig.phoneNumberId && envConfig.accessToken && envConfig.webhookSecret && envConfig.verifyToken) {
    console.log("Config found in environment variables");
    const config = envConfig as ConfigData;
    configCache = config;
    return config;
  }

  console.log("No configuration found");
  return null;
}

export function setConfig(config: ConfigData): void {
  console.log("Setting config:", { 
    phoneNumberId: config.phoneNumberId,
    hasAccessToken: !!config.accessToken,
    hasWebhookSecret: !!config.webhookSecret,
    hasVerifyToken: !!config.verifyToken
  });
  
  // Update cache
  configCache = config;
  
  // Save to file
  saveConfigToFile(config);
}

export function clearConfig(): void {
  console.log("Clearing config");
  configCache = null;
  // Note: We don't delete the file to avoid permission issues
} 