"use client";

import React, { Suspense, useState, useEffect } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

import { useURLParams } from "@/contexts/url-params-context";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Check if we're on mobile
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768; // md breakpoint
      setIsMobile(mobile);
      // Auto-close sidebar when switching to desktop
      if (!mobile) {
        setIsMobileSidebarOpen(false);
      }
    };

    // Initial check
    if (typeof window !== 'undefined') {
      checkMobile();
    }

    // Listen for resize events
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const toggleMobileSidebar = () => {
    setIsMobileSidebarOpen(!isMobileSidebarOpen);
  };

  return (
    <ViewerLayout>
      <div className="flex h-full w-full overflow-hidden relative">
        {/* Mobile Header with Hamburger Menu */}
        {isMobile && (
          <div className="absolute top-0 left-0 right-0 z-50 bg-background border-b p-2 md:hidden">
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleMobileSidebar}
                className="p-2"
              >
                {isMobileSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </Button>
              <h1 className="text-sm font-medium text-center flex-1">AG-UI Dojo</h1>
              <div className="w-9" /> {/* Spacer for centering */}
            </div>
          </div>
        )}

        {/* Mobile Overlay */}
        {isMobile && isMobileSidebarOpen && (
          <div
            className="absolute inset-0 bg-black/50 z-40 md:hidden"
            onClick={toggleMobileSidebar}
          />
        )}
        {/* Sidebar */}
        <Suspense>
          <MaybeSidebar
            isMobile={isMobile}
            isMobileSidebarOpen={isMobileSidebarOpen}
            onMobileClose={() => setIsMobileSidebarOpen(false)}
          />
        </Suspense>

        {/* Content */}
        <div className={`flex-1 overflow-auto ${isMobile ? 'pt-12' : ''}`}>
          <div className="h-full">{children}</div>
        </div>
      </div>
    </ViewerLayout>
  );
}

interface MaybeSidebarProps {
  isMobile: boolean;
  isMobileSidebarOpen: boolean;
  onMobileClose: () => void;
}

function MaybeSidebar({ isMobile, isMobileSidebarOpen, onMobileClose }: MaybeSidebarProps) {
  const { sidebarHidden } = useURLParams();

  // Don't render sidebar if disabled by query param
  if (sidebarHidden) return null;

  // On mobile, only show if open
  if (isMobile && !isMobileSidebarOpen) return null;

  return (
    <div className={`
      ${isMobile 
        ? 'absolute left-0 top-0 z-50 h-full w-80 transform transition-transform duration-300 ease-in-out' 
        : 'relative'
      }
    `}>
      <Sidebar
        isMobile={isMobile}
        onMobileClose={onMobileClose}
      />
    </div>
  );
}