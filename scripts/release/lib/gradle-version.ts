/** The first quoted root version and its value offsets (without quotes). */
export interface GradleVersion {
  version: string;
  start: number;
  end: number;
}

export function parseGradleVersion(content: string): GradleVersion {
  function skipSpaceAndComments(index: number): number {
    while (index < content.length) {
      if (/\s/.test(content[index])) index++;
      else if (content.startsWith("//", index)) {
        const end = content.indexOf("\n", index);
        index = end < 0 ? content.length : end + 1;
      } else if (content.startsWith("/*", index)) {
        let comments = 1;
        index += 2;
        while (index < content.length && comments) {
          if (content.startsWith("/*", index)) {
            comments++;
            index += 2;
          } else if (content.startsWith("*/", index)) {
            comments--;
            index += 2;
          } else index++;
        }
      } else break;
    }
    return index;
  }
  function stringEnd(index: number, delimiter: string): number {
    index += delimiter.length;
    while (index < content.length) {
      if (content.startsWith(delimiter, index)) return index;
      index += delimiter.length === 1 && content[index] === "\\" ? 2 : 1;
    }
    return -1;
  }

  let index = 0,
    depth = 0,
    previous = "";
  while ((index = skipSpaceAndComments(index)) < content.length) {
    const char = content[index];
    if (char === '"' || char === "'") {
      const delimiter = content.startsWith('"""', index) ? '"""' : char;
      const end = stringEnd(index, delimiter);
      index = end < 0 ? content.length : end + delimiter.length;
      previous = "string";
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(content.slice(index))?.[0];
    if (
      word === "version" &&
      depth === 0 &&
      ![".", "val", "var", "`"].includes(previous)
    ) {
      const equals = skipSpaceAndComments(index + word.length);
      if (content[equals] === "=" && content[equals + 1] !== "=") {
        const quote = skipSpaceAndComments(equals + 1);
        if (content[quote] !== '"')
          throw new Error("Cannot read quoted root Gradle version");
        const delimiter = content.startsWith('"""', quote) ? '"""' : '"';
        const end = stringEnd(quote, delimiter);
        if (end < 0) throw new Error("Unterminated root Gradle version");
        const start = quote + delimiter.length;
        return { version: content.slice(start, end), start, end };
      }
    }
    if ("{([".includes(char)) depth++;
    if ("})]".includes(char)) depth = Math.max(0, depth - 1);
    previous = word ?? char;
    index += word?.length ?? 1;
  }
  throw new Error("Cannot find root Gradle version");
}

export function replaceGradleVersion(
  content: string,
  nextVersion: string,
): string {
  const { start, end } = parseGradleVersion(content);
  return content.slice(0, start) + nextVersion + content.slice(end);
}
