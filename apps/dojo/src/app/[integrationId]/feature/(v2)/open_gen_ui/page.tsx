"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotKitProvider,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";

interface OpenGenUIProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const OpenGenUI: React.FC<OpenGenUIProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkitnext/${integrationId}`}
      showDevConsole={false}
    >
      <Chat />
    </CopilotKitProvider>
  );
};

const Chat = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Bar chart",
        message:
          "Build a bar chart showing quarterly revenue: Q1 $2.1M, Q2 $3.4M, Q3 $2.8M, Q4 $4.2M",
      },
      {
        title: "Spreadsheet",
        message: "Create a spreadsheet with sample sales data for 5 products",
      },
      {
        title: "3D Cube",
        message: "Show me a rotating 3D cube using Three.js",
      },
      {
        title: "Calculator",
        message: "Build me a beautiful calculator app",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="open_gen_ui"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

export default OpenGenUI;
