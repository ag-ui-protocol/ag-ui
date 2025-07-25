import React from "react";
import { ViewerConfig } from "@/types/feature";
import { cn } from "@/lib/utils";

interface ViewerLayoutProps extends ViewerConfig {
  className?: string;
  children?: React.ReactNode;
  codeEditor?: React.ReactNode;
  fileTree?: React.ReactNode;
  sidebarHeader?: React.ReactNode;
}

export function ViewerLayout({
  className,
  children,
}: ViewerLayoutProps) {
  return (
    <div className={cn("flex h-screen", className)}>
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-auto">
          <div className="h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
