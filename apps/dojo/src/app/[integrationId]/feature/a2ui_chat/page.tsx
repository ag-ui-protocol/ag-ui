"use client";

import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { createA2UIMessageRenderer } from "@copilotkit/a2ui-renderer";
import { theme } from "./theme";

export const dynamic = "force-dynamic";

const activityRenderers = [createA2UIMessageRenderer({ theme })];

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

function Chat({ agentId }: { agentId: string }) {
  return <CopilotChat className="flex-1 overflow-hidden" agentId={agentId} />;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);
  const showToggle = integrationId === "langgraph-fastapi";
  const [injectTool, setInjectTool] = useState(false);
  const agentId = injectTool && showToggle ? "a2ui_chat_inject" : "a2ui_chat";

  return (
    <CopilotKitProvider
      key={agentId}
      runtimeUrl={`/api/copilotkitnext/${integrationId}`}
      showDevConsole="auto"
      renderActivityMessages={activityRenderers}
    >
      <div className="a2ui-chat-container flex flex-col h-full overflow-hidden">
        {showToggle && (
          <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, borderBottom: "1px solid #e2e2e2" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={injectTool}
                onChange={(e) => setInjectTool(e.target.checked)}
              />
              injectA2UITool
            </label>
            <span style={{ color: "#888" }}>
              {injectTool ? "(frontend tool injection)" : "(backend auto-detection)"}
            </span>
          </div>
        )}
        <Chat agentId={agentId} />
      </div>
    </CopilotKitProvider>
  );
}
