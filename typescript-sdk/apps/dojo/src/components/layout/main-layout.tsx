"use client";

import React, { Suspense, useState } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";

import { useSearchParams } from "next/navigation";

export function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ViewerLayout showFileTree={false} showCodeEditor={false}>
      <div className="flex h-full w-full overflow-hidden">
        {/* Sidebar */}
        <Suspense>
          <MaybeSidebar/>
        </Suspense>


        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="h-full">{children}</div>
        </div>
      </div>
    </ViewerLayout>
  );
}

function MaybeSidebar() {
  const searchParams = useSearchParams();

  const sidebarDisabled = searchParams.get("sidebar") === "disabled";
  const integrationPickerDisabled = searchParams.get("picker") === "false";

  return !sidebarDisabled && <Sidebar activeTab={"preview"} readmeContent={""} pickerDisabled={integrationPickerDisabled} />;
}