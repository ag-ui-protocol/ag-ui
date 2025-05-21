"use client";

import React, { useState } from "react";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { Sidebar } from "@/components/sidebar/sidebar";

import { usePathname } from "next/navigation";
import featureConfig from "@/config";
import ReactMarkdown from "react-markdown";
import { MarkdownComponents } from "@/components/ui/markdown-components";
import { MDXContent } from "@/components/ui/mdx-components";
import { MDXRenderer, SafeComponent } from "@/utils/mdx-utils";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<string>("preview");
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [compiledMDX, setCompiledMDX] = useState<string | null>(null);

  // Extract the current demo ID from the pathname
  const pathParts = pathname.split("/");
  const currentDemoId = pathParts[pathParts.length - 1];
  const currentDemo = featureConfig.find((d) => d.id === currentDemoId);

  return (
    <ViewerLayout showFileTree={false} showCodeEditor={false}>
      <div className="flex h-full w-full overflow-hidden">
        {/* Sidebar */}
        <Sidebar activeTab={activeTab} readmeContent={readmeContent} />

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {activeTab === "preview" ? (
            <div className="h-full">{children}</div>
          ) : activeTab === "readme" && readmeContent ? (
            <div className="flex-1 p-6 overflow-auto bg-background">
              <div className="max-w-4xl mx-auto">
                <div className="prose max-w-none">
                  {compiledMDX ? (
                    <MDXContent>
                      <SafeComponent
                        component={() => (
                          <MDXRenderer content={readmeContent} demoId={currentDemoId} />
                        )}
                        fallback={
                          <div className="p-4 border rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300">
                            Could not render MDX content. Displaying markdown instead.
                            <ReactMarkdown components={MarkdownComponents}>
                              {readmeContent || ""}
                            </ReactMarkdown>
                          </div>
                        }
                      />
                    </MDXContent>
                  ) : (
                    <ReactMarkdown components={MarkdownComponents}>{readmeContent}</ReactMarkdown>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              Select a demo from the list to get started
            </div>
          )}
        </div>
      </div>
    </ViewerLayout>
  );
}
