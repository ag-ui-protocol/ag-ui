"use client";

import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat,   } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core"; 

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkitnext/${integrationId}`}
      showDevConsole={false}
      agent="vnext_chat"
    >
      <main
        className="flex min-h-screen flex-1 flex-col overflow-hidden"
        style={{ minHeight: "100dvh" }}
      >
        <Chat />
      </main>
    </CopilotKit>
  );
}

function Chat() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <CopilotChat style={{ flex: 1, minHeight: "100%" }} />
    </div>
  );
}
