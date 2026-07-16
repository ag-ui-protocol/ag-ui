"""Small, dependency-free Markdown retrieval for the docs Copilot example."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from math import log


_WORD_RE = re.compile(r"[a-z0-9]+")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_STOP_WORDS = {
    "a",
    "an",
    "about",
    "and",
    "are",
    "do",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "the",
    "to",
    "use",
    "what",
    "with",
}


def _terms(value: str) -> list[str]:
    """Normalize prose and Python identifiers into searchable terms."""
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value).replace("_", "-")
    return [term for term in _WORD_RE.findall(value.lower()) if term not in _STOP_WORDS]


@dataclass(frozen=True)
class _Section:
    heading: str
    content: str
    heading_terms: frozenset[str]
    content_terms: tuple[str, ...]


class MarkdownSearchIndex:
    """Rank Markdown sections with BM25 and return the relevant excerpts."""

    def __init__(self, document: str) -> None:
        self._sections = self._split_sections(document)
        self._document_frequency = Counter(
            term for section in self._sections for term in set(section.content_terms)
        )
        self._average_section_length = (
            sum(len(section.content_terms) for section in self._sections)
            / len(self._sections)
            if self._sections
            else 0.0
        )

    @staticmethod
    def _split_sections(document: str) -> list[_Section]:
        sections: list[_Section] = []
        heading = "Overview"
        lines: list[str] = []

        def append_section() -> None:
            content = "\n".join(lines).strip()
            if not content:
                return
            sections.append(
                _Section(
                    heading=heading,
                    content=content,
                    heading_terms=frozenset(_terms(heading)),
                    content_terms=tuple(_terms(content)),
                )
            )

        for line in document.splitlines():
            match = _HEADING_RE.match(line)
            if match:
                append_section()
                heading = match.group(2).strip()
                lines = [line]
            else:
                lines.append(line)
        append_section()
        return sections

    def search(self, query: str, *, limit: int = 3, max_chars: int = 7_000) -> str:
        """Return the highest-scoring sections within a character budget."""
        query_terms = set(_terms(query))
        if not query_terms:
            return "No specific documentation terms were supplied."

        ranked: list[tuple[float, int, _Section]] = []
        for position, section in enumerate(self._sections):
            frequencies = Counter(section.content_terms)
            score = 0.0
            for term in query_terms:
                frequency = frequencies[term]
                if not frequency:
                    continue
                document_frequency = self._document_frequency[term]
                inverse_frequency = log(
                    1
                    + (len(self._sections) - document_frequency + 0.5)
                    / (document_frequency + 0.5)
                )
                length_ratio = len(section.content_terms) / self._average_section_length
                saturation = (frequency * 2.2) / (
                    frequency + 1.2 * (0.25 + 0.75 * length_ratio)
                )
                score += inverse_frequency * saturation
                if term in section.heading_terms:
                    score += inverse_frequency * 2
            if score:
                ranked.append((score, -position, section))

        if not ranked:
            return "No relevant section was found in this documentation source."

        excerpts: list[str] = []
        used_chars = 0
        for _, _, section in sorted(ranked, reverse=True)[:limit]:
            separator_size = 2 if excerpts else 0
            if used_chars + separator_size + len(section.content) > max_chars:
                continue
            excerpts.append(section.content)
            used_chars += separator_size + len(section.content)

        if not excerpts:
            return "The closest documentation section exceeds the retrieval budget."
        return "\n\n".join(excerpts)


__all__ = ["MarkdownSearchIndex"]
