"use client";

import React from "react";
import { menuIntegrations } from "@/menu";
import { notFound } from "next/navigation";

interface IntegrationPageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function IntegrationPage({ params }: IntegrationPageProps) {
  const { integrationId } = React.use(params);

  // Find the integration by ID
  const integration = menuIntegrations.find((integration) => integration.id === integrationId);

  // If integration not found, show 404
  if (!integration) {
    notFound();
  }

  return (
    <div className="flex-1 h-screen w-full flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-center">{integration.name}</h1>
      <p className="text-muted-foreground mt-4">Integration ID: {integration.id}</p>
    </div>
  );
}
