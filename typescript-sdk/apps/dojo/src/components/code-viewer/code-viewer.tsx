import { useMemo, useState } from "react";
import { FileTree } from "@/components/file-tree/file-tree";
import { CodeEditor } from './code-editor'
import { FeatureFile } from "@/types/feature";
import { useURLParams } from "@/contexts/url-params-context";

export default function CodeViewer({
  codeFiles
}: {
  codeFiles: FeatureFile[];
}) {
  const { file, setCodeFile } = useURLParams();

  const selectedFile = useMemo(() => (
    codeFiles.find(f => f.name === file) ?? codeFiles[0]
  ), [codeFiles, file])

  return (
    <div className="flex h-full">
      <div className="w-72 border-r flex flex-col bg-background">
        <div className="flex-1 overflow-auto">
          <FileTree
            files={codeFiles}
            selectedFile={selectedFile}
            onFileSelect={setCodeFile}
          />
        </div>
      </div>
      <div className="flex-1 h-full py-5 bg-[#1e1e1e]">
        {selectedFile ? (
          <div className="h-full">
            <CodeEditor
              file={selectedFile}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select a file to view its content.
          </div>
        )}
      </div>
    </div>
  )
}