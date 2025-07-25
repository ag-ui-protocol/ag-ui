"use client";

import React, { Suspense } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";
import { useURLParams } from "@/contexts/url-params-context";

export function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <ViewerLayout>
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
  const { sidebarHidden } = useURLParams();

  return !sidebarHidden && <Sidebar />;
}