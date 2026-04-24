#!/usr/bin/env tsx
/**
 * Polishes raw release notes using Claude API.
 * Falls back to raw notes if ANTHROPIC_API_KEY is not set.
 *
 * Usage: cat raw-notes.md | tsx generate-ai-release-notes.ts
 *    or: tsx generate-ai-release-notes.ts <file>
 */
import fs from "fs";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const input = process.argv[2]
    ? fs.readFileSync(process.argv[2], "utf-8")
    : fs.readFileSync("/dev/stdin", "utf-8");

  if (!apiKey) {
    console.error("No ANTHROPIC_API_KEY set — using raw release notes");
    process.stdout.write(input);
    return;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are writing release notes for an open-source SDK. Polish the following raw commit-based release notes into clear, user-facing prose. Group related changes, highlight breaking changes, and write in present tense. Keep it concise — developers read these quickly. Output markdown only, no preamble.\n\n${input}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    console.error(
      `Claude API error (${response.status}) — using raw release notes`
    );
    process.stdout.write(input);
    return;
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
  };
  process.stdout.write(data.content[0].text);
}

main().catch((err) => {
  console.error(`AI release notes failed: ${err.message} — using raw notes`);
  const input = process.argv[2]
    ? fs.readFileSync(process.argv[2], "utf-8")
    : "";
  if (input) {
    process.stdout.write(input);
  }
});
