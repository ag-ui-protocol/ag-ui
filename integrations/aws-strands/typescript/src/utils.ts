/** Utility functions for AWS Strands integration. */

import type {
  InputContent,
  TextInputContent,
  ImageInputContent,
  DocumentInputContent,
  VideoInputContent,
  InputContentSource,
} from "@ag-ui/core";
import {
  ImageBlock,
  DocumentBlock,
  VideoBlock,
  TextBlock,
  type ContentBlock,
  type ImageFormat,
  type DocumentFormat,
  type VideoFormat,
} from "@strands-agents/sdk";
import { DEFAULT_LOGGER, type Logger } from "./logger";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

// Allowed formats per media type for Strands ContentBlock
const IMAGE_FORMATS = new Set<string>(["png", "jpeg", "gif", "webp"]);
const DOCUMENT_FORMATS = new Set<string>([
  "pdf",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "html",
  "txt",
  "md",
]);
const VIDEO_FORMATS = new Set<string>([
  "flv",
  "mkv",
  "mov",
  "mpeg",
  "mpg",
  "mp4",
  "three_gp",
  "webm",
  "wmv",
]);

/** Parse a MIME type into a short format string; returns null if absent or unsupported. */
function mimeToFormat(
  mimeType: string | undefined,
  allowed: Set<string>,
  log: Logger,
): string | null {
  if (!mimeType) {
    log.warn(`${LOG_PREFIX} No MIME type provided, cannot determine format`);
    return null;
  }
  const fmt = mimeType.split("/").pop()?.toLowerCase() ?? "";
  if (allowed.has(fmt)) {
    return fmt;
  }
  log.warn(
    `${LOG_PREFIX} Unsupported MIME type '${mimeType}' (parsed format '${fmt}' not in ${JSON.stringify([...allowed].sort())})`,
  );
  return null;
}

/** Fetch raw bytes from a URL using the global fetch (Node 20+). */
async function fetchUrlBytes(
  url: string,
  log: Logger,
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      log.warn(`${LOG_PREFIX} Failed to fetch URL ${url}: HTTP ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    log.warn(`${LOG_PREFIX} Failed to fetch URL ${url}:`, e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeBase64(value: string, log: Logger): Uint8Array | null {
  try {
    const bin = globalThis.atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch (e) {
    log.warn(`${LOG_PREFIX} Failed to decode base64 content:`, e);
    return null;
  }
}

/** Resolve bytes from an AG-UI content source. */
async function resolveSourceBytes(
  source: InputContentSource,
  log: Logger,
): Promise<Uint8Array | null> {
  if (source.type === "data") {
    return decodeBase64(source.value, log);
  }
  if (source.type === "url") {
    return await fetchUrlBytes(source.value, log);
  }
  log.warn(
    `${LOG_PREFIX} Unknown content source type: ${(source as { type?: string }).type}, cannot resolve bytes`,
  );
  return null;
}

/**
 * Convert an AG-UI `InputContent` list to Strands `ContentBlock` values.
 *
 * Supported types:
 *  - `TextInputContent` -> `TextBlock`
 *  - `ImageInputContent` -> `ImageBlock` (png, jpeg, gif, webp)
 *  - `DocumentInputContent` -> `DocumentBlock` (pdf, csv, doc, docx, xls, xlsx, html, txt, md)
 *  - `VideoInputContent` -> `VideoBlock` (flv, mkv, mov, mpeg, mpg, mp4, three_gp, webm, wmv)
 *  - `AudioInputContent` — skipped (Strands has no audio support).
 *  - Unresolvable items (bad MIME, fetch failure) — skipped.
 */
export async function convertAguiContentToStrands(
  content: InputContent[],
  log: Logger = DEFAULT_LOGGER,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  for (const item of content) {
    if (item.type === "text") {
      blocks.push(new TextBlock((item as TextInputContent).text));
      continue;
    }

    if (item.type === "image") {
      const imageItem = item as ImageInputContent;
      const bytes = await resolveSourceBytes(imageItem.source, log);
      if (!bytes) continue;
      const fmt = mimeToFormat(imageItem.source.mimeType, IMAGE_FORMATS, log);
      if (!fmt) continue;
      blocks.push(
        new ImageBlock({ format: fmt as ImageFormat, source: { bytes } }),
      );
      continue;
    }

    if (item.type === "document") {
      const docItem = item as DocumentInputContent;
      const bytes = await resolveSourceBytes(docItem.source, log);
      if (!bytes) continue;
      const fmt = mimeToFormat(docItem.source.mimeType, DOCUMENT_FORMATS, log);
      if (!fmt) continue;
      blocks.push(
        new DocumentBlock({
          format: fmt as DocumentFormat,
          name: "document",
          source: { bytes },
        }),
      );
      continue;
    }

    if (item.type === "video") {
      const vidItem = item as VideoInputContent;
      const bytes = await resolveSourceBytes(vidItem.source, log);
      if (!bytes) continue;
      const fmt = mimeToFormat(vidItem.source.mimeType, VIDEO_FORMATS, log);
      if (!fmt) continue;
      blocks.push(
        new VideoBlock({ format: fmt as VideoFormat, source: { bytes } }),
      );
      continue;
    }

    if (item.type === "audio") {
      log.warn(
        `${LOG_PREFIX} Skipping audio content: Strands has no audio support`,
      );
      continue;
    }

    if (item.type === "binary") {
      // Deprecated legacy binary content — try to map to an image block.
      const bin = item as {
        type: "binary";
        mimeType: string;
        url?: string;
        data?: string;
      };
      let bytes: Uint8Array | null = null;
      if (bin.data) {
        bytes = decodeBase64(bin.data, log);
      } else if (bin.url) {
        bytes = await fetchUrlBytes(bin.url, log);
      }
      if (!bytes) {
        log.warn(
          `${LOG_PREFIX} Skipping binary content: could not resolve bytes`,
        );
        continue;
      }
      const fmt = mimeToFormat(bin.mimeType, IMAGE_FORMATS, log);
      if (!fmt) {
        log.warn(
          `${LOG_PREFIX} Skipping binary content: unsupported MIME type '${bin.mimeType}'`,
        );
        continue;
      }
      blocks.push(
        new ImageBlock({ format: fmt as ImageFormat, source: { bytes } }),
      );
      continue;
    }

    log.warn(
      `${LOG_PREFIX} Skipping unknown content type: ${(item as { type?: string }).type}`,
    );
  }

  return blocks;
}

/** Extract plain text from AG-UI message content or Strands content blocks. */
export function flattenContentToText(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const typed = item as { type?: string; text?: string };
      // AG-UI TextInputContent
      if (typed.type === "text" && typeof typed.text === "string") {
        parts.push(typed.text);
      }
      // Strands TextBlock
      if (typed.type === "textBlock" && typeof typed.text === "string") {
        parts.push(typed.text);
      }
    }
    return parts.join(" ");
  }
  return "";
}
