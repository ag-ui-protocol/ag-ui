import getEnvVars from "@/env";


export function getTitleForCurrentDomain(): string | undefined {
  const envVars = getEnvVars();

  // Check if we're in the browser
  if (typeof window == "undefined") {
    return undefined;
  }

  const host = window.location.hostname;
  return envVars.customDomainTitle[host] || undefined;
}