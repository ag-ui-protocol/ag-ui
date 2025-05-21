"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter, usePathname } from "next/navigation";
import { DemoList } from "@/components/demo-list/demo-list";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Eye, Code, Book, List, ChevronDown } from "lucide-react";
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

interface SidebarProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  readmeContent?: string | null;
}

export function Sidebar({ activeTab = "preview", onTabChange, readmeContent }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(false);

  // Extract the current demo ID from the pathname
  const pathParts = pathname.split("/");
  const currentDemoId = pathParts[pathParts.length - 1];

  // Handle selecting a demo
  const handleDemoSelect = (demoId: string) => {
    const demo = featureConfig.find((d) => d.id === demoId);
    if (demo) {
      router.push(demo.path);
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

  const handleTabChange = (value: string) => {
    if (onTabChange) {
      onTabChange(value);
    }
  };

  return (
    <div className="flex flex-col h-full w-74 min-w-[296px] flex-shrink-0 border-r">
      {/* Sidebar Header */}
      <div className="p-4 border-b bg-background">
        <div className="flex items-center justify-between ml-1">
          <div className="flex items-start flex-col">
            <Image
              src={isDarkTheme ? "/logo_light.webp" : "/logo_dark.webp"}
              width={120}
              height={24}
              alt="CopilotKit"
              className="h-6 w-auto object-contain"
            />
            <h1
              className={`text-lg font-extralight ${isDarkTheme ? "text-white" : "text-gray-900"}`}
            >
              Interactive Dojo
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
                Select Integration
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>View Options</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Eye className="mr-2 h-4 w-4" />
                <span>Preview</span>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Code className="mr-2 h-4 w-4" />
                <span>Code</span>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Book className="mr-2 h-4 w-4" />
                <span>Documentation</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Demo List */}
      <div className="flex-1 overflow-auto">
        <DemoList demos={featureConfig} selectedDemo={currentDemoId} onSelect={handleDemoSelect} />
      </div>
    </div>
  );
}
