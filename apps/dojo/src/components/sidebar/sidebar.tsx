"use client";

import React, { useState, useEffect } from "react";
import {
  EyeIcon as Eye,
  CodeIcon as Code,
  BookOpenTextIcon as Book,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DemoList } from "@/components/demo-list/demo-list";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ChevronDown } from "lucide-react";
import featureConfig from "@/config";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "../ui/button";
import { menuIntegrations } from "@/menu";
import type { Feature } from "@/types/integration";
import { useURLParams } from "@/contexts/url-params-context";
import { View } from "@/types/interface";
import { getTitleForCurrentDomain } from "@/utils/domain-config";
import { useTheme } from "next-themes";

interface SidebarProps {
  isMobile?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ isMobile, onMobileClose }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { theme, setTheme } = useTheme();
  const isDarkTheme = theme === "dark";
  const {
    view,
    frameworkPickerHidden,
    viewPickerHidden,
    featurePickerHidden,
    setView,
  } = useURLParams();

  // Extract the current integration ID from the pathname
  const pathParts = pathname.split("/");
  const currentIntegrationId = pathParts[1]; // First segment after root
  const currentDemoId = pathParts[pathParts.length - 1];

  // Find the current integration (only if we have a valid integration ID)
  const currentIntegration =
    currentIntegrationId && currentIntegrationId !== ""
      ? menuIntegrations.find(
          (integration) => integration.id === currentIntegrationId,
        )
      : null;

  // Filter demos based on current integration's features
  const filteredDemos = currentIntegration
    ? featureConfig.filter((demo) =>
        (currentIntegration.features as Feature[]).includes(demo.id as Feature),
      )
    : []; // Show no demos if no integration is selected

  // Handle selecting a demo
  const handleDemoSelect = (demoId: string) => {
    if (currentIntegration) {
      const queryString = searchParams.toString();
      const newPath = `/${currentIntegration.id}/feature/${demoId}`;
      const url = queryString ? `${newPath}?${queryString}` : newPath;
      router.push(url);
      // Close mobile sidebar when demo is selected
      if (isMobile && onMobileClose) {
        onMobileClose();
      }
    }
  };

  // Handle integration selection
  const handleIntegrationSelect = (integrationId: string) => {
    const queryString = searchParams.toString();
    const newPath = `/${integrationId}`;
    const url = queryString ? `${newPath}?${queryString}` : newPath;
    router.push(url);
  };

  const tabClass = `cursor-pointer flex-1 h-8 px-2 text-sm text-primary shadow-none bg-none border-none font-medium gap-1 rounded-lg data-[state=active]:bg-white data-[state=active]:text-primary data-[state=active]:shadow-none`;

  return (
    <div
      className={`flex flex-col h-full border-2 border-palette-border-default
      ${isMobile ? "w-80 shadow-xl bg-white z-99" : "bg-white/50 w-74 min-w-[296px] flex-shrink-0 rounded-lg overflow-hidden"}
    `}
    >
      {/* Sidebar Header */}
      <div className="p-4">
        <div className="flex items-center justify-between ml-1">
          <div className="flex items-start flex-col">
            <h1
              className={`text-lg font-light ${isDarkTheme ? "text-white" : "text-gray-900"}`}
            >
              {getTitleForCurrentDomain() || "AG-UI Interactive Dojo"}
            </h1>
          </div>

          {/*<ThemeToggle />*/}
        </div>
      </div>

      {/* Controls Section */}
      {(!frameworkPickerHidden || !viewPickerHidden) && (
        <div className="p-4 border-b">
          {/* Integration picker */}
          {!frameworkPickerHidden && (
            <div className="mb-spacing-4">
              <SectionTitle title="Integrations" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <div className="flex items-center justify-between h-spacing-8 rounded-sm gap-spacing-2 px-spacing-3 transition-colors hover:bg-palette-surface-containerHovered cursor-pointer">
                    <span className="pb-[2px] text-palette-text-primary font-medium leading-[22px] inline-block truncate">
                      {currentIntegration
                        ? currentIntegration.name
                        : "Select Integration"}
                    </span>
                    <ChevronDown
                      className="text-palette-icon-default transition-transform"
                      size={16}
                    />
                  </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="ml-4 w-80 bg-palette-surface-container border-palette-border-container shadow-elevation-md">
                  {menuIntegrations.map((integration) => (
                    <DropdownMenuItem
                      key={integration.id}
                      onClick={() => handleIntegrationSelect(integration.id)}
                      className="cursor-pointer hover:bg-palette-grey-200 text-palette-text-primary text-base h-12 rounded-sm"
                    >
                      <span>{integration.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {/* Preview/Code Tabs */}
          {!viewPickerHidden && (
            <div className="mb-1">
              <SectionTitle title="View" />
              <Tabs
                value={view}
                onValueChange={(tab) => setView(tab as View)}
                className="w-full rounded-lg bg-none border-none"
              >
                <TabsList className="w-full rounded-lg h-8 p-0 bg-transparent border-none">
                  <TabsTrigger value="preview" className={tabClass}>
                    <Eye className="h-3 w-3" />
                    <span>Preview</span>
                  </TabsTrigger>
                  <TabsTrigger value="code" className={tabClass}>
                    <Code className="h-3 w-3" />
                    <span>Code</span>
                  </TabsTrigger>
                  <TabsTrigger value="readme" className={tabClass}>
                    <Book className="h-3 w-3" />
                    <span>Docs</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}
        </div>
      )}

      {/* Demo List */}
      <div className="flex-1 overflow-auto">
        {currentIntegration && !featurePickerHidden ? (
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

function SectionTitle({ title }: { title: string }) {
  return (
    <div className={cn("items-center", "flex px-spacing-1 gap-spacing-2 mb-2")}>
      <label
        className={cn(
          "transition-all duration-300 ease-in-out inline-block whitespace-nowrap paragraphs-Small-Regular-Uppercase text-[10px] text-palette-text-secondary opacity-100 scale-100 w-fit",
        )}
      >
        {title}
      </label>
      <div
        className={cn(
          "h-[1px] bg-palette-border-container transition-all duration-300 ease-[cubic-bezier(0.36,0.01,0.22,1)]",
          "w-full",
        )}
      />
    </div>
  );
}
