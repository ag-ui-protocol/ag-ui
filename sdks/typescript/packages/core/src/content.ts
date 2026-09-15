import type { ContentPart } from "./generated/types";

/**
 * The text of string-or-parts content, for a consumer that can only hold a
 * string: the text parts concatenated in order, every other part dropped.
 *
 * This is the downgrade the specification permits for a peer that predates
 * content parts (/spec/draft/basic/versioning): it removes and reshapes, and
 * it invents nothing — no placeholder stands in for a dropped image, because a
 * downgrade MUST NOT supply a value the producer never sent. Content that is
 * entirely media flattens to the empty string, which the same rule allows.
 *
 * Losing content is never meant to be silent. This helper only reshapes; a
 * caller that knows it is talking to an older peer warns as well, the way the
 * era shims in `@ag-ui/client` do.
 */
export function contentToText(content: string | ContentPart[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Whether string-or-parts content carries anything but text — the question a
 * caller asks before flattening, so it can warn about what the flattening
 * would drop.
 */
export function contentHasMedia(content: string | ContentPart[] | undefined): boolean {
  return Array.isArray(content) && content.some((part) => part.type !== "text");
}
