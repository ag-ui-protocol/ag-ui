#!/usr/bin/env python3
"""Read the first quoted root Gradle version, preserving source offsets."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def parse_gradle_version(content: str) -> tuple[str, int, int]:
    def skip_space_and_comments(index: int) -> int:
        while index < len(content):
            if content[index].isspace(): index += 1
            elif content.startswith("//", index):
                end = content.find("\n", index)
                index = len(content) if end < 0 else end + 1
            elif content.startswith("/*", index):
                comments, index = 1, index + 2
                while index < len(content) and comments:
                    if content.startswith("/*", index): comments += 1; index += 2
                    elif content.startswith("*/", index): comments -= 1; index += 2
                    else: index += 1
            else: break
        return index

    def string_end(index: int, delimiter: str) -> int:
        index += len(delimiter)
        while index < len(content):
            if content.startswith(delimiter, index): return index
            index += 2 if len(delimiter) == 1 and content[index] == "\\" else 1
        return -1

    index, depth, previous = 0, 0, ""
    while (index := skip_space_and_comments(index)) < len(content):
        char = content[index]
        if char in ('"', "'"):
            delimiter = '"""' if content.startswith('"""', index) else char
            end = string_end(index, delimiter)
            index = len(content) if end < 0 else end + len(delimiter)
            previous = "string"
            continue
        match = re.match(r"[A-Za-z_$][\w$]*", content[index:])
        word = match[0] if match else None
        if word == "version" and depth == 0 and previous not in (".", "val", "var", "`"):
            equals = skip_space_and_comments(index + len(word))
            if content[equals:equals + 1] == "=" and content[equals + 1:equals + 2] != "=":
                quote = skip_space_and_comments(equals + 1)
                if content[quote:quote + 1] != '"': raise ValueError("Cannot read quoted root Gradle version")
                delimiter = '"""' if content.startswith('"""', quote) else '"'
                end = string_end(quote, delimiter)
                if end < 0: raise ValueError("Unterminated root Gradle version")
                start = quote + len(delimiter)
                return content[start:end], start, end
        if char in "{([": depth += 1
        if char in "})]": depth = max(0, depth - 1)
        previous = word or char
        index += len(word) if word else 1
    raise ValueError("Cannot find root Gradle version")


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <file>", file=sys.stderr)
        sys.exit(1)
    try:
        print(parse_gradle_version(Path(sys.argv[1]).read_bytes().decode("utf-8"))[0])
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
