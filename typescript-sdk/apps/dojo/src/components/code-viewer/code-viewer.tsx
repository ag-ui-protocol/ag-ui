import { useMemo, useState } from "react";
import { FileTree } from "@/components/file-tree/file-tree";
import { CodeEditor } from "./code-editor";
import { FeatureFile } from "@/types/feature";
import { useURLParams } from "@/contexts/url-params-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function CodeViewer({ codeFiles }: { codeFiles: FeatureFile[] }) {
  const { file, setCodeFile, codeLayout } = useURLParams();

  const selectedFile = useMemo(
    () => codeFiles.find((f) => f.name === file) ?? codeFiles[0],
    [codeFiles, file],
  );

  if (codeLayout === "tabs") {
    return (
      <div className="flex flex-col h-full">
        <Tabs
          value={selectedFile?.name}
          onValueChange={setCodeFile}
          className="flex-1 flex flex-col"
        >
          <TabsList className="w-full justify-start h-auto flex-wrap p-1">
            {codeFiles.map((file) => (
              <TabsTrigger
                key={file.name}
                value={file.name}
                className="border border-transparent data-[state=active]:border-indigo-200"
              >
                {file.name.split("/").pop()}
              </TabsTrigger>
            ))}
          </TabsList>
          {codeFiles.map((file) => (
            <TabsContent
              key={file.name}
              value={file.name}
              className="flex-1 mt-0 data-[state=inactive]:hidden"
            >
              <div className="h-full bg-[#1e1e1e]">
                <CodeEditor file={file} />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="w-72 border-r flex flex-col bg-background">
        <div className="flex-1 overflow-auto">
          <FileTree files={codeFiles} selectedFile={selectedFile} onFileSelect={setCodeFile} />
        </div>
      </div>
      <div className="flex-1 h-full py-5 bg-[#1e1e1e]">
        {selectedFile ? (
          <div className="h-full">
            <CodeEditor file={selectedFile} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select a file to view its content.
          </div>
        )}
      </div>
    </div>
  );
}
