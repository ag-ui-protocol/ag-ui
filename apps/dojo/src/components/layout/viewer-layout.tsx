import React from "react";
import { ViewerConfig } from "@/types/feature";
import { cn } from "@/lib/utils";
import { useMobileView } from "@/utils/use-mobile-view";
import { useURLParams } from "@/contexts/url-params-context";

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
  const { sidebarHidden } = useURLParams();
  const { isMobile } = useMobileView();

  return (
    <div className={cn("relative flex h-screen overflow-hidden bg-palette-surface-main", className, {
      "p-spacing-2": !isMobile && !sidebarHidden,
    })}>
      <div className="flex flex-1 overflow-hidden z-1">
        <main className="flex-1 overflow-auto">
          <div className="h-full">{children}</div>
        </main>
      </div>
      {/* Background blur circles - Figma exact specs */}
      {/* Ellipse 1351 */}
      <div className="absolute w-[445.84px] h-[445.84px] left-[1040px] top-[11px] rounded-full z-0" 
           style={{ background: 'rgba(255, 172, 77, 0.2)', filter: 'blur(103.196px)' }} />
      
      {/* Ellipse 1347 */}
      <div className="absolute w-[609.35px] h-[609.35px] left-[1338.97px] top-[624.5px] rounded-full z-0"
           style={{ background: '#C9C9DA', filter: 'blur(103.196px)' }} />
      
      {/* Ellipse 1350 */}
      <div className="absolute w-[609.35px] h-[609.35px] left-[670px] top-[-365px] rounded-full z-0"
           style={{ background: '#C9C9DA', filter: 'blur(103.196px)' }} />
      
      {/* Ellipse 1348 */}
      <div className="absolute w-[609.35px] h-[609.35px] left-[507.87px] top-[702.14px] rounded-full z-0"
           style={{ background: '#F3F3FC', filter: 'blur(103.196px)' }} />
      
      {/* Ellipse 1346 */}
      <div className="absolute w-[445.84px] h-[445.84px] left-[127.91px] top-[331px] rounded-full z-0"
           style={{ background: 'rgba(255, 243, 136, 0.3)', filter: 'blur(103.196px)' }} />
      
      {/* Ellipse 1268 */}
      <div className="absolute w-[445.84px] h-[445.84px] left-[-205px] top-[802.72px] rounded-full z-0"
           style={{ background: 'rgba(255, 172, 77, 0.2)', filter: 'blur(103.196px)' }} />
    </div>
  );
}
