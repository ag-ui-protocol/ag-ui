"use client";

import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import { createA2UIMessageRenderer } from "@copilotkit/a2ui-renderer";
import { theme } from "./theme";

export const dynamic = "force-dynamic";

const activityRenderers = [createA2UIMessageRenderer({ theme })];

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
      <div className="a2ui-chat-container flex flex-col h-full overflow-hidden">
        <CopilotChat className="flex-1 overflow-hidden" />
      </div>
    </CopilotKitProvider>
  );
}
