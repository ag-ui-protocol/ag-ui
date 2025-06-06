import React from "react";
import { menuIntegrations } from "@/menu";
import { notFound } from "next/navigation";
import Readme from "@/components/readme/readme";
import path from "path";
import fs from "fs";

export async function generateStaticParams() {
  return menuIntegrations.map((integration) => ({
    integrationId: integration.id,
  }));
}

interface IntegrationPageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function IntegrationPage({ params }: IntegrationPageProps) {
  const { integrationId } = React.use(params);

  // Find the integration by ID
  const integration = menuIntegrations.find((integration) => integration.id === integrationId);

  const readmePath = path.join(
    process.cwd(),
    "..",
    "..",
    "integrations",
    integrationId,
    "README.md",
  );

  let md: string | undefined = undefined;

  if (fs.existsSync(readmePath)) {
    md = fs.readFileSync(readmePath, "utf8");
  }

  // If integration not found, show 404
  if (!integration) {
    notFound();
  }

  if (!md) {
    return (
      <div className="flex-1 h-screen w-full flex flex-col items-center justify-start pt-16 px-8">
        <div className="w-full max-w-4xl">
          <h1 className="text-4xl font-bold text-center">{integration.name}</h1>
          <p className="text-muted-foreground mt-4 text-center">Integration ID: {integration.id}</p>
        </div>
      </div>
    );
  } else {
    return <Readme content={md} />;
  }
}
