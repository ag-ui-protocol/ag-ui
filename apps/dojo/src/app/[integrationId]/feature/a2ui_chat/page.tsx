"use client";

import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import { createA2UIMessageRenderer } from "@copilotkit/a2ui-renderer";
import { theme } from "./theme";

export const dynamic = "force-dynamic";

const A2UIMessageRenderer = createA2UIMessageRenderer({ theme });
const activityRenderers = [A2UIMessageRenderer];

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkita2ui/${integrationId}`}
      showDevConsole="auto"
      renderActivityMessages={activityRenderers}
    >
      <main
        className="flex min-h-screen flex-1 flex-col overflow-hidden"
        style={{ minHeight: "100dvh" }}
      >
        <CopilotChat style={{ flex: 1, minHeight: "100%" }} />
      </main>
    </CopilotKitProvider>
  );
}
