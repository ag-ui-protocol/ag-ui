'use client';

import React, { useMemo } from "react";
import { usePathname } from "next/navigation";
import filesJSON from '../../../files.json'
import Readme from "@/components/readme/readme";
import CodeViewer from "@/components/code-viewer/code-viewer";
import { useURLParams } from "@/contexts/url-params-context";
import { cn } from "@/lib/utils";
import type { Feature } from "@/types/integration";

type FileItem = {
  name: string;
  content: string;
  language: string;
  type: string;
};

type FilesJsonType = Record<string, FileItem[]>;

interface Props {
  children: React.ReactNode;
}

export default function FeatureLayoutClient({ children }: Props) {
  const { sidebarHidden } = useURLParams();
  const { view } = useURLParams();
  const pathname = usePathname();

  // Extract integrationId and featureId from pathname: /[integrationId]/feature/[featureId]
  const pathParts = pathname.split("/").filter(Boolean);
  const integrationId = pathParts[0] || "";
  const featureId = pathParts[2] as Feature;

  const files = (filesJSON as FilesJsonType)[`${integrationId}::${featureId}`] || [];

  const readme = files.find((file) => file?.name?.includes(".mdx")) || null;
  const codeFiles = files.filter(
    (file) => file && Object.keys(file).length > 0 && !file.name?.includes(".mdx"),
  );

  const content = useMemo(() => {
    switch (view) {
      case "code":
        return (
          <CodeViewer key={`${integrationId}::${featureId}`} codeFiles={codeFiles} />
        )
      case "readme":
        return (
          <Readme key={`${integrationId}::${featureId}`} content={readme?.content ?? ''} />
        )
      default:
        return (
          <div className="h-full">{children}</div>
        )
    }
  }, [children, codeFiles, readme, view, integrationId, featureId])

  return (
    <div className={cn(
      "bg-white w-full h-full overflow-hidden",
      // if used in iframe, match background to chat background color, otherwise, use white
      sidebarHidden && "bg-(--copilot-kit-background-color)",
      // if not used in iframe, round the corners of the content area
      !sidebarHidden && "rounded-lg",
    )}>
      <div className="flex flex-col h-full overflow-auto">
        {content}
      </div>
    </div>
  );
}
