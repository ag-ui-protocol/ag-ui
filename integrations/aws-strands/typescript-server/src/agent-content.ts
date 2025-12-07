import type {
  ContentBlockData,
  DocumentFormat,
  ImageFormat,
} from "@strands-agents/sdk";
import type {
  BinaryMessageContent,
  MessageContent,
  TextMessageContent,
} from "./types";

export type ConvertedMessageContent = {
  blocks: ContentBlockData[];
  textSummary: string;
  textBlockIndexes: number[];
  hasBinaryContent: boolean;
};

export function convertMessageContent(
  content?: MessageContent
): ConvertedMessageContent {
  const blocks: ContentBlockData[] = [];
  const textBlockIndexes: number[] = [];
  const summaryParts: string[] = [];
  let attachmentCounter = 0;
  let hasBinaryContent = false;

  const pushText = (text: string | null | undefined) => {
    if (!text) return;
    blocks.push({ text });
    textBlockIndexes.push(blocks.length - 1);
    summaryParts.push(text);
  };

  if (content === undefined) {
    return { blocks, textSummary: "", textBlockIndexes, hasBinaryContent };
  }

  if (typeof content === "string") {
    pushText(content);
    return {
      blocks,
      textSummary: summaryParts.join("\n"),
      textBlockIndexes,
      hasBinaryContent,
    };
  }

  if (!Array.isArray(content)) {
    try {
      pushText(JSON.stringify(content));
    } catch {
      pushText(String(content));
    }
    return {
      blocks,
      textSummary: summaryParts.join("\n"),
      textBlockIndexes,
      hasBinaryContent,
    };
  }

  for (const item of content) {
    if (isTextContentPart(item)) {
      pushText(item.text);
      continue;
    }
    if (isBinaryContentPart(item)) {
      const description = describeBinaryContent(item);
      summaryParts.push(description);
      const binaryBlock = binaryContentToContentBlock(
        item,
        attachmentCounter + 1
      );
      if (binaryBlock) {
        blocks.push(binaryBlock);
        attachmentCounter += 1;
        hasBinaryContent = true;
      } else {
        pushText(description);
      }
      continue;
    }
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      pushText(String(item));
      continue;
    }
    if (item === null || item === undefined) {
      continue;
    }
    if (isRecord(item) && typeof item.text === "string") {
      pushText(item.text);
      continue;
    }
    try {
      pushText(JSON.stringify(item));
    } catch {
      pushText(String(item));
    }
  }

  return {
    blocks,
    textSummary: summaryParts.join("\n"),
    textBlockIndexes,
    hasBinaryContent,
  };
}

export function applyBuilderTextToBlocks(
  blocks: ContentBlockData[],
  textIndexes: number[],
  newText: string
): ContentBlockData[] {
  if (!blocks.length) {
    return newText ? [{ text: newText }] : [];
  }

  const indexSet = new Set(textIndexes);
  const updated: ContentBlockData[] = [];
  let inserted = false;

  blocks.forEach((block, index) => {
    if (indexSet.has(index)) {
      if (!inserted && newText) {
        updated.push({ text: newText });
        inserted = true;
      }
      return;
    }
    updated.push(block);
  });

  if (!inserted && newText) {
    updated.unshift({ text: newText });
  }

  return updated;
}

function isTextContentPart(value: unknown): value is TextMessageContent {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isBinaryContentPart(value: unknown): value is BinaryMessageContent {
  return (
    isRecord(value) &&
    value.type === "binary" &&
    typeof value.mimeType === "string"
  );
}

function describeBinaryContent(content: BinaryMessageContent): string {
  let urlLabel: string | null = null;
  if (content.url) {
    try {
      urlLabel = new URL(content.url).pathname.split("/").pop() ?? null;
    } catch {
      urlLabel = content.url;
    }
  }
  const label = content.filename || content.id || urlLabel || content.mimeType;
  return `[Attachment ${content.mimeType}: ${label ?? "unnamed"}]`;
}

function binaryContentToContentBlock(
  content: BinaryMessageContent,
  sequence: number
): ContentBlockData | null {
  const mimeType = content.mimeType.toLowerCase();
  const filename =
    content.filename ||
    `attachment-${sequence}.${mimeType.split("/")[1] || "bin"}`;

  if (mimeType.startsWith("image/")) {
    const format = guessImageFormat(mimeType, filename);
    if (!format) {
      return null;
    }

    if (content.url) {
      return {
        image: {
          format,
          source: { url: content.url },
        },
      };
    }

    if (content.data) {
      const bytes = decodeBase64Value(content.data);
      if (bytes) {
        return {
          image: {
            format,
            source: { bytes },
          },
        };
      }
    }

    return null;
  }

  const documentFormat = guessDocumentFormat(mimeType, filename);
  if (!documentFormat) {
    return null;
  }

  if (content.data) {
    const bytes = decodeBase64Value(content.data);
    if (bytes) {
      return {
        document: {
          name: filename,
          format: documentFormat,
          source: { bytes },
        },
      };
    }
  }

  return null;
}

function decodeBase64Value(value: string): Uint8Array | null {
  try {
    const normalized = value.includes(",")
      ? (value.split(",").pop() ?? value)
      : value;
    return Uint8Array.from(Buffer.from(normalized, "base64"));
  } catch {
    return null;
  }
}

function guessImageFormat(
  mimeType: string,
  filename?: string
): ImageFormat | null {
  const subtype = mimeType.split("/")[1] ?? "";
  const normalizedSubtype = subtype.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(normalizedSubtype)) {
    return normalizedSubtype as ImageFormat;
  }
  if (filename) {
    const extension = filename.split(".").pop()?.toLowerCase();
    if (
      extension &&
      ["png", "jpg", "jpeg", "gif", "webp"].includes(extension)
    ) {
      return extension as ImageFormat;
    }
  }
  return null;
}

function guessDocumentFormat(
  mimeType: string,
  filename?: string
): DocumentFormat | null {
  const subtype = mimeType.split("/")[1] ?? "";
  const normalizedSubtype = subtype.toLowerCase();
  const mimeMap: Record<string, DocumentFormat> = {
    pdf: "pdf",
    msword: "doc",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.ms-excel": "xls",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    csv: "csv",
    plain: "txt",
    html: "html",
    markdown: "md",
    json: "json",
    xml: "xml",
  };
  const mapped = mimeMap[normalizedSubtype];
  if (mapped) {
    return mapped;
  }
  if (filename) {
    const extension = filename.split(".").pop()?.toLowerCase();
    const extensionMap: Record<string, DocumentFormat> = {
      pdf: "pdf",
      csv: "csv",
      doc: "doc",
      docx: "docx",
      xls: "xls",
      xlsx: "xlsx",
      html: "html",
      htm: "html",
      txt: "txt",
      md: "md",
      json: "json",
      xml: "xml",
    };
    if (extension) {
      return extensionMap[extension] ?? null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
