#!/usr/bin/env node
/**
 * Post a PR merge-readiness analysis to Notion.
 *
 * Usage:
 *   NOTION_TOKEN=<your_token> node scripts/post-to-notion.js
 *
 * Creates a new page under the ag-ui team's Notion workspace
 * (parent page ID from PR #1250: 2e63aa38185280648a35dc4f43a80749).
 *
 * Requires: Node.js 18+ (uses built-in fetch)
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PARENT_PAGE_ID = "2e63aa38185280648a35dc4f43a80749";

if (!NOTION_TOKEN) {
  console.error("Error: NOTION_TOKEN environment variable is required.");
  console.error("  export NOTION_TOKEN=secret_xxx");
  process.exit(1);
}

const PAGE_TITLE = "PR Merge-Readiness Analysis \u2014 Safe to Merge After Rebase";

const ANALYSIS_BLOCKS = [
  {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: "Analysis generated on 2026-03-13. In-depth Claude Code reviews launched on all 10 PRs for code-level verification." } }],
      icon: { emoji: "\uD83D\uDCCB" },
      color: "blue_background",
    },
  },
  { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "\uD83D\uDFE2 Tier 1: Almost Certainly Safe to Merge (after rebase)" } }] } },
  {
    object: "block", type: "table",
    table: {
      table_width: 3, has_column_header: true, has_row_header: false,
      children: [
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "PR" } }], [{ type: "text", text: { content: "Title" } }], [{ type: "text", text: { content: "Why it's safe" } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1248" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Guard process.env for browser compat" } }], [{ type: "text", text: { content: "Already approved by maintainer AlemTuzlak, all CI green, 2 files, supersedes bloated #1192. Safest merge." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1022" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Fix typo in generative UI specs" } }], [{ type: "text", text: { content: "Single character typo fix. Zero functional risk." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1225" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Add tRPC-Agent-Go to integrations docs" } }], [{ type: "text", text: { content: "Docs-only: adds 2 lines to README tables. No code touched." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1091" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Next.js standalone build docs" } }], [{ type: "text", text: { content: "Docs-only: 12 additions documenting a real workaround (#1009). No code." } }]] } },
      ],
    },
  },
  { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "\uD83D\uDFE1 Tier 2: Very Likely Safe \u2014 Reviews Will Confirm" } }] } },
  {
    object: "block", type: "table",
    table: {
      table_width: 3, has_column_header: true, has_row_header: false,
      children: [
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "PR" } }], [{ type: "text", text: { content: "Title" } }], [{ type: "text", text: { content: "Risk factor to verify" } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1258" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Pass graphId filter in assistant search" } }], [{ type: "text", text: { content: "Minimal (5 additions, 9 deletions), CI passing. Only risk: whether LangGraph API supports the graph_id filter parameter as used." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1289" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Use system message for A2UI user actions" } }], [{ type: "text", text: { content: "Net deletion (20 added, 53 removed). CI passing. Risk: behavioral change — confirm no downstream consumers depend on old synthetic tool call format." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1195" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Make Tool.parameters optional in Python SDK" } }], [{ type: "text", text: { content: "Cross-SDK alignment fix. Making a field optional is backward-compatible." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#837" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Reset message ID on text-end (Mastra)" } }], [{ type: "text", text: { content: "7-line swap, 3 community users requesting merge. Risk: no CI configured. Need to verify text-end is the correct Mastra stream event name." } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#1298" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Preserve reasoning messages after snapshot" } }], [{ type: "text", text: { content: "Surgical fix adding 'reasoning' to a role filter list. Verify reasoning messages don't cause duplicates through snapshots." } }]] } },
      ],
    },
  },
  { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "\uD83D\uDFE0 Tier 3: Needs Careful Review \u2014 Potential Subtle Risk" } }] } },
  {
    object: "block", type: "table",
    table: {
      table_width: 3, has_column_header: true, has_row_header: false,
      children: [
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "PR" } }], [{ type: "text", text: { content: "Title" } }], [{ type: "text", text: { content: "Concern" } }]] } },
        { object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "#899" }, annotations: { bold: true } }], [{ type: "text", text: { content: "Fix excessive cloning in subscribers" } }], [{ type: "text", text: { content: "Correct diagnosis, significant perf win (810ms to fast). Removes per-subscriber defensive cloning. If any subscriber mutates the message array, it could corrupt state for other subscribers. Trades safety for performance." } }]] } },
      ],
    },
  },
  { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "Recommendation" } }] } },
  { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Merge immediately: " }, annotations: { bold: true } }, { type: "text", text: { content: "#1248, #1022, #1225, #1091" } }] } },
  { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Merge after review completes: " }, annotations: { bold: true } }, { type: "text", text: { content: "#1258, #1289, #1195, #837, #1298" } }] } },
  { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Merge with caution: " }, annotations: { bold: true } }, { type: "text", text: { content: "#899 (verify no subscribers mutate shared state)" } }] } },
  { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Close as superseded: " }, annotations: { bold: true } }, { type: "text", text: { content: "#1192 (replaced by #1248)" } }] } },
];

async function createNotionPage() {
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      parent: { page_id: PARENT_PAGE_ID },
      icon: { emoji: "\uD83D\uDCCA" },
      properties: {
        title: { title: [{ type: "text", text: { content: PAGE_TITLE } }] },
      },
      children: ANALYSIS_BLOCKS,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Notion API error ${response.status}: ${error}`);
    process.exit(1);
  }

  const page = await response.json();
  console.log("Page created successfully!");
  console.log(`   Title: ${PAGE_TITLE}`);
  console.log(`   URL:   ${page.url}`);
  console.log(`   ID:    ${page.id}`);
}

createNotionPage().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
