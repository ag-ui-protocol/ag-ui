import { useMemo } from "react";
import { FileTree } from "@/components/file-tree/file-tree";
import { CodeEditor } from "./code-editor";
import { FeatureFile } from "@/types/feature";
import { useURLParams } from "@/contexts/url-params-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsInsideCpkFrame } from "@/utils/use-is-inside-iframe";
import { cn } from "@/lib/utils";

export default function CodeViewer({ codeFiles }: { codeFiles: FeatureFile[] }) {
  const { file, setCodeFile, codeLayout } = useURLParams();
  const isInsideCpkFrame = useIsInsideCpkFrame();

  const selectedFile = useMemo(
    () => codeFiles.find((f) => f.name === file) ?? codeFiles[0],
    [codeFiles, file],
  );

  if (codeLayout === "tabs") {
    return (
      <div className="flex flex-col h-full bg-white">
        <Tabs
          value={selectedFile?.name}
          onValueChange={setCodeFile}
          className="flex-1 flex flex-col bg-cpk-docs-dark-bg/3 dark:bg-cpk-docs-dark-bg/95"
        >
          <TabsList className="w-full justify-start h-auto flex-wrap p-1 gap-1 rounded-none bg-transparent">
            {codeFiles.map((file) => (
              <TabsTrigger
                key={file.name}
                value={file.name}
                className={cn(
                  "border-0 shadow-none hover:bg-foreground/5 hover:text-gray-900 dark:hover:text-neutral-100 data-[state=active]:text-gray-900 dark:data-[state=active]:text-white",
                  isInsideCpkFrame
                    ? "mix-from-cpk-docs-primary mix-to-white mix-25 data-[state=active]:bg-mix/15 data-[state=active]:text-cpk-docs-primary data-[state=active]:dark:text-mix"
                    : "data-[state=active]:bg-foreground/8 text-gray-600 dark:text-neutral-300",
                )}
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
              <div className={cn(
                "h-full border border-b-0 border-cpk-docs-dark-bg/8 dark:border-white/6 -mx-px",
                isInsideCpkFrame && "rounded-xl overflow-hidden",
              )}>
                <CodeEditor file={file} />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-white">
      {/* wrapper div to mix the parent bg-white with bg-cpk-docs-dark-bg */}
      <div className="flex h-full w-full bg-cpk-docs-dark-bg/3 dark:bg-cpk-docs-dark-bg/95">
        <div className="w-72 border-r border-gray-200 dark:border-neutral-700 flex flex-col">
          <div className="flex-1 overflow-auto">
            <FileTree files={codeFiles} selectedFile={selectedFile} onFileSelect={setCodeFile} />
          </div>
        </div>
        <div className={cn(
          "flex-1 h-full bg-gray-50 dark:bg-[#1e1e1e]",
          isInsideCpkFrame && "rounded-xl overflow-hidden",
        )}>
          {selectedFile ? (
            <div className="h-full border-cpk-docs-dark-bg/8 dark:border-white/6">
              <CodeEditor file={selectedFile} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground dark:text-neutral-300">
              Select a file to view its content.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
