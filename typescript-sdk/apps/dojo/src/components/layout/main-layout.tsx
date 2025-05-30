"use client";

import React, { useState } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";

import { usePathname } from "next/navigation";
import featureConfig from "@/config";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Extract the current demo ID from the pathname
  const pathParts = pathname.split("/");
  const currentFeatureId = pathParts[pathParts.length - 1];
  const currentFeature = featureConfig.find((d) => d.id === currentFeatureId);

  return (
    <ViewerLayout showFileTree={false} showCodeEditor={false}>
      <div className="flex h-full w-full overflow-hidden">
        {/* Sidebar */}
        <Sidebar activeTab={"preview"} readmeContent={""} />

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="h-full">{children}</div>
        </div>
      </div>
    </ViewerLayout>
  );
}
