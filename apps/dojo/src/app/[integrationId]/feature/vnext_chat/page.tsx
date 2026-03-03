"use client";

import React from "react";
import "@copilotkitnext/react/styles.css";
import { CopilotChat, CopilotKitProvider } from "@copilotkitnext/react";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkitnext/${integrationId}`}
      showDevConsole="auto"
    >
      <main
        className="flex min-h-screen flex-1 flex-col overflow-hidden"
        style={{ minHeight: "100dvh" }}
      >
        <Chat />
      </main>
    </CopilotKitProvider>
  );
}

function Chat() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <CopilotChat style={{ flex: 1, minHeight: "100%" }} />
    </div>
  );
}
