"use client";

import { MDXRenderer } from "@/utils/mdx-utils";

export default function Readme({ content }: { content: string }) {
  return (
    <div className="flex-1 h-screen w-full flex flex-col items-center justify-start pt-24 px-8">
      <div className="w-full max-w-4xl">{<MDXRenderer content={content} />}</div>
    </div>
  );
}
