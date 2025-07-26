'use client';

import React, { useMemo } from "react";
import { usePathname } from "next/navigation";
import filesJSON from '../../../files.json'
import Readme from "@/components/readme/readme";
import CodeViewer from "@/components/code-viewer/code-viewer";
import { useURLParams } from "@/contexts/url-params-context";

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
  const { integrationId } = React.use(params);
  const pathname = usePathname();
  const { view } = useURLParams();

  // Extract featureId from pathname: /[integrationId]/feature/[featureId]
  const pathParts = pathname.split('/');
  const featureId = pathParts[pathParts.length - 1]; // Last segment is the featureId

  const files = (filesJSON as FilesJsonType)[`${integrationId}::${featureId}`];

  const readme = files.find(file => file.name.includes('.mdx'));
  const codeFiles = files.filter(file => !file.name.includes('.mdx'));


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

  return <div className="bg-(--copilot-kit-background-color) w-full h-full">{content}</div>;
}
