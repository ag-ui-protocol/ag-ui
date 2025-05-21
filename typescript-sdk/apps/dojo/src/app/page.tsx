"use client";

import React from "react";
import { integrations } from "@/integrations";

export default function Home() {
  return (
    <div className="flex-1 h-screen w-full flex flex-col items-center mt-16 p-8">
      <h1 className="text-base font-normal text-muted-foreground mb-4">
        Select an integration to get started
      </h1>
      <div className="flex flex-col w-full max-w-md space-y-2">
        {integrations.map((integration) => (
          <a
            key={integration.id}
            href={`/${integration.id}`}
            className="p-4 rounded-md border border-border bg-card hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
          >
            <h2 className="text-lg font-medium">{integration.name}</h2>
          </a>
        ))}
      </div>
    </div>
  );
}
