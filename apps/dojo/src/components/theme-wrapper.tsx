"use client";

import { ThemeProvider } from "@/components/theme-provider";
import { useURLParams } from "@/contexts/url-params-context";

export function ThemeWrapper({ children }: { children: React.ReactNode }) {
  const { sidebarHidden, theme } = useURLParams();

  return (
    <ThemeProvider
      attribute="class"
      // if used in iframe, detect theme passed via url param, otherwise, use light
      forcedTheme={sidebarHidden ? theme : "light"}
      enableSystem={false}
      themes={["light", "dark"]}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}

