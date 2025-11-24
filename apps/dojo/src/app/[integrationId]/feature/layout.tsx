'use client';

import React, { useMemo } from "react";
import { usePathname } from "next/navigation";
import filesJSON from '../../../files.json'
import Readme from "@/components/readme/readme";
import CodeViewer from "@/components/code-viewer/code-viewer";
import { useURLParams } from "@/contexts/url-params-context";
import { cn } from "@/lib/utils";

type FileItem = {
  name: string;
  content: string;
  language: string;
  type: string;
};

type FilesJsonType = Record<string, FileItem[]>;

interface Props {
  params: Promise<{
    integrationId: string;
  }>;
  children: React.ReactNode
}

export default function FeatureLayout({ children, params }: Props) {
  const { sidebarHidden } = useURLParams();
  const { integrationId } = React.use(params);
  const pathname = usePathname();
  const { view } = useURLParams();

  // Extract featureId from pathname: /[integrationId]/feature/[featureId]
  const pathParts = pathname.split('/');
  const featureId = pathParts[pathParts.length - 1]; // Last segment is the featureId

  const files = (filesJSON as FilesJsonType)[`${integrationId}::${featureId}`] || [];

  const readme = files.find((file) => file?.name?.includes(".mdx")) || null;
  const codeFiles = files.filter(
    (file) => file && Object.keys(file).length > 0 && !file.name?.includes(".mdx"),
  );


  const content = useMemo(() => {
    switch (view) {
      case "code":
        return (
          <CodeViewer codeFiles={codeFiles} />
        )
      case "readme":
        return (
          <Readme content={readme?.content ?? ''} />
        )
      default:
        return (
          <div className="h-full">{children}</div>
        )
    }
  }, [children, codeFiles, readme, view])

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
