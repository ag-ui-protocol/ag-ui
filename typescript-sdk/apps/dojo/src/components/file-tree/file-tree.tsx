import React from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { FeatureFile } from "@/types/feature";

// Helper function to convert flat file paths to a hierarchical structure
// function convertToFileTree(files: FeatureFile[]) {
//   const root: FeatureFile[] = [];
//   const map: Record<string, FeatureFile> = {};
//
//   // First pass: create all directories and files
//   files.forEach((file) => {
//     // Split the path into segments
//     const pathParts = file.path.split("/");
//     const fileName = pathParts.pop();
//
//     let currentPath = "";
//     let currentLevel = root;
//
//     // Create or navigate the directory structure
//     pathParts.forEach((part) => {
//       currentPath = currentPath ? `${currentPath}/${part}` : part;
//
//       // Check if this directory already exists
//       let dir = map[currentPath];
//       if (!dir) {
//         // Create new directory
//         dir = {
//           name: part,
//           path: currentPath,
//           type: "directory",
//           content: "",
//           children: [],
//         };
//         map[currentPath] = dir;
//         currentLevel.push(dir);
//       }
//
//       // Navigate to this directory for the next iteration
//       currentLevel = dir.children || [];
//     });
//
//     // Add the file to the last directory level
//     currentLevel.push({
//       name: fileName || "",
//       path: file.path,
//       type: "file",
//       content: "",
//     });
//   });
//
//   return root;
// }

interface FileTreeProps {
  files: FeatureFile[];
  onFileSelect: (fileName: string) => void;
  selectedFile?: FeatureFile;
}

function FileTreeNode({
  entry,
  depth = 0,
  onFileSelect,
  selectedFileName,
}: {
  entry: FeatureFile;
  depth?: number;
  onFileSelect: (fileName: string) => void;
  selectedFileName?: string;
}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const isDirectory = entry.type === "directory";
  const isSelected = entry.name === selectedFileName;

  return (
    <div className={cn("relative", depth > 0 && "pl-2")}>
      {depth > 0 && <div className="absolute left-0 top-0 h-full w-px bg-border" />}
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent/50",
          isSelected && "bg-accent",
          depth === 1 && "ml-0.5",
          depth === 2 && "ml-1",
          depth === 3 && "ml-1.5",
          depth === 4 && "ml-2",
          depth > 4 && "ml-2.5",
        )}
        onClick={() => {
          if (isDirectory) {
            setIsOpen(!isOpen);
          } else {
            onFileSelect(entry.name);
          }
        }}
      >
        {isDirectory ? (
          <>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Folder className="h-4 w-4" />
          </>
        ) : (
          <>
            <span className="w-4" />
            <File className="h-4 w-4" />
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
    </div>
  );
}

export function FileTree({ files, onFileSelect, selectedFile }: FileTreeProps) {
  return (
    <div className="p-2">
      {files.map((entry) => (
        <FileTreeNode
          key={entry.name}
          entry={entry}
          onFileSelect={onFileSelect}
          selectedFileName={selectedFile?.name}
        />
      ))}
    </div>
  );
}
