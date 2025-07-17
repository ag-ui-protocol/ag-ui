"use client";

import React, { useState } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";

import { usePathname, useSearchParams } from "next/navigation";
import featureConfig from "@/config";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sidebarDisabled = searchParams.get("sidebar") === "disabled";
  const integrationPickerDisabled = searchParams.get("picker") === "false";

  // Extract the current demo ID from the pathname
  const pathParts = pathname.split("/");
  const currentFeatureId = pathParts[pathParts.length - 1];
  const currentFeature = featureConfig.find((d) => d.id === currentFeatureId);

  return (
    <ViewerLayout showFileTree={false} showCodeEditor={false}>
      <div className="flex h-full w-full overflow-hidden">
        {/* Sidebar */}
        {!sidebarDisabled && <Sidebar activeTab={"preview"} readmeContent={""} pickerDisabled={integrationPickerDisabled} />}

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="h-full">{children}</div>
        </div>
      </div>
    </ViewerLayout>
  );
}
