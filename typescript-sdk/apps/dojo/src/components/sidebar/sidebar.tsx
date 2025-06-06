"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { DemoList } from "@/components/demo-list/demo-list";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Eye, Code, Book, ChevronDown } from "lucide-react";
import featureConfig from "@/config";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { menuIntegrations } from "@/menu";
import { Feature } from "@/types/integration";

interface SidebarProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  readmeContent?: string | null;
}

export function Sidebar({ activeTab = "preview", onTabChange, readmeContent }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(false);

  // Extract the current integration ID from the pathname
  const pathParts = pathname.split("/");
  const currentIntegrationId = pathParts[1]; // First segment after root
  const currentDemoId = pathParts[pathParts.length - 1];

  // Find the current integration (only if we have a valid integration ID)
  const currentIntegration =
    currentIntegrationId && currentIntegrationId !== ""
      ? menuIntegrations.find((integration) => integration.id === currentIntegrationId)
      : null;

  // Filter demos based on current integration's features
  const filteredDemos = currentIntegration
    ? featureConfig.filter((demo) =>
        currentIntegration.features.includes(demo.id as unknown as Feature),
      )
    : []; // Show no demos if no integration is selected

  // Handle selecting a demo
  const handleDemoSelect = (demoId: string) => {
    if (currentIntegration) {
      router.push(`/${currentIntegration.id}/feature/${demoId}`);
    }
  };

  // Check for dark mode using media query
  useEffect(() => {
    // Check if we're in the browser
    if (typeof window !== "undefined") {
      // Initial check
      setIsDarkTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);

      // Listen for changes
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (e: MediaQueryListEvent) => {
        setIsDarkTheme(e.matches);
      };

      mediaQuery.addEventListener("change", handleChange);

      // Also check for .dark class which is added by next-themes
      const observer = new MutationObserver(() => {
        setIsDarkTheme(document.documentElement.classList.contains("dark"));
      });

      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });

      return () => {
        mediaQuery.removeEventListener("change", handleChange);
        observer.disconnect();
      };
    }
  }, []);

  return (
    <div className="flex flex-col h-full w-74 min-w-[296px] flex-shrink-0 border-r">
      {/* Sidebar Header */}
      <div className="p-4 border-b bg-background">
        <div className="flex items-center justify-between ml-1">
          <div className="flex items-start flex-col">
            <h1 className={`text-lg font-light ${isDarkTheme ? "text-white" : "text-gray-900"}`}>
              AG-UI Interactive Dojo
            </h1>
          </div>

          <ThemeToggle />
        </div>
      </div>

      {/* Controls Section */}
      <div className="p-4 border-b bg-background">
        {/* Preview/Code Tabs */}
        <div className="mb-1">
          <label className="block text-sm font-medium text-muted-foreground mb-2">View</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-between">
                {currentIntegration ? currentIntegration.name : "Select Integration"}
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {menuIntegrations.map((integration) => (
                <DropdownMenuItem
                  key={integration.id}
                  onClick={() => {
                    router.push(`/${integration.id}`);
                  }}
                  className="cursor-pointer"
                >
                  <span>{integration.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Demo List */}
      <div className="flex-1 overflow-auto">
        {currentIntegration ? (
          <DemoList
            demos={filteredDemos}
            selectedDemo={currentDemoId}
            onSelect={handleDemoSelect}
          />
        ) : (
          <div className="flex items-center justify-center h-full p-8">
            <p className="text-muted-foreground text-center"></p>
          </div>
        )}
      </div>
    </div>
  );
}
