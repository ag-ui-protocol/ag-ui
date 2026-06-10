/**
 * aimock fixtures for the Google ADK A2UI demos (OSS-158).
 *
 * These emulate what the ADK adapter sees from a REAL Gemini sub-agent under the
 * free-form tool schema: `render_a2ui` returns `components`/`data` as JSON
 * *strings* (not structured arrays/objects), because Gemini's function-calling
 * fills typed `array<object>` args strictly (empty `{}`), so the ADK adapter
 * declares them as STRING and parses them back via `_coerce_freeform_args`.
 * Encoding them as strings here drives that real code path — in contrast to the
 * LangGraph/gpt-4o fixtures (a2ui-recovery-fixtures.ts), which use structured
 * arrays the way OpenAI fills loose schemas.
 *
 * Scoped to Gemini requests (`req.model` ~ "gemini-*") so they never intercept
 * the OpenAI LangGraph demos. Register BEFORE registerA2UIRecoveryFixtures so a
 * Gemini request matches here first; gpt-4o requests fall through.
 *
 * Covers: a2ui_dynamic_schema (valid hotel surface) and a2ui_recovery
 * (recover: invalid→valid; exhaust: always invalid).
 */
import type { LLMock, ChatMessage } from "@copilotkit/aimock";

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join("");
  }
  return "";
};
const allText = (messages: ChatMessage[] = []): string => messages.map((m) => textOf(m.content)).join("\n");
const userText = (messages: ChatMessage[] = []): string =>
  textOf(messages.filter((m) => m.role === "user").pop()?.content);

// Toolkit appends this on a retry (augment_prompt_with_validation_errors).
const RETRY_MARKER = "Previous attempt was invalid";

const isGemini = (req: any) => /gemini/i.test(String(req?.model ?? ""));
const isRecover = (text: string) => /luxury/i.test(text) && !/different cities/i.test(text);
const isExhaust = (text: string) => /broken/i.test(text);
// dynamic_schema hotel prompt ("...comparison of 3 hotels...") — not luxury/broken.
const isHotelCreate = (text: string) => /comparison of 3 hotels/i.test(text);

const ROOT = { id: "root", component: "Row", children: { componentId: "card", path: "/items" }, gap: 16 };
const CARD = {
  id: "card",
  component: "HotelCard",
  name: { path: "name" },
  location: { path: "location" },
  rating: { path: "rating" },
  pricePerNight: { path: "price" },
  action: { event: { name: "book_hotel", context: { hotelName: { path: "name" } } } },
};
const HOTELS = [
  { name: "The Ritz", location: "Paris", rating: 4.8, price: "$450/night" },
  { name: "Holiday Inn", location: "Austin", rating: 4.1, price: "$180/night" },
  { name: "Boutique Loft", location: "Lisbon", rating: 4.6, price: "$320/night" },
];

// Gemini free-form shape: components/data are JSON STRINGS within the args.
// valid → [root, card]; invalid → [root] only (root's child ref `card` is missing).
const renderArgsGemini = (valid: boolean) =>
  JSON.stringify({
    surfaceId: "hotel-comparison",
    components: JSON.stringify(valid ? [ROOT, CARD] : [ROOT]),
    data: JSON.stringify({ items: HOTELS }),
  });

export function registerA2UIADKFixtures(mockServer: LLMock): void {
  const hasTool = (req: any, name: string) => req.tools?.some((t: any) => t.function.name === name);
  const wantsA2UI = (req: any) =>
    isHotelCreate(userText(req.messages)) || isRecover(userText(req.messages)) || isExhaust(userText(req.messages));

  // 1) Main ADK agent: A2UI prompt → call the generate_a2ui sub-agent tool.
  mockServer.addFixture({
    match: { predicate: (req: any) => isGemini(req) && hasTool(req, "generate_a2ui") && wantsA2UI(req) },
    response: { toolCalls: [{ name: "generate_a2ui", arguments: JSON.stringify({ intent: "create" }) }] },
  });

  // 2) Sub-agent — dynamic_schema create → valid surface (Gemini-shaped args).
  mockServer.addFixture({
    match: { predicate: (req: any) => isGemini(req) && hasTool(req, "render_a2ui") && isHotelCreate(allText(req.messages)) },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgsGemini(true) }] },
  });

  // 3) Sub-agent — EXHAUST ("broken"): always the dangling-ref surface (invalid).
  mockServer.addFixture({
    match: { predicate: (req: any) => isGemini(req) && hasTool(req, "render_a2ui") && isExhaust(allText(req.messages)) },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgsGemini(false) }] },
  });

  // 4) Sub-agent — RECOVER ("luxury"), RETRY (errors fed back) → valid.
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        isGemini(req) && hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && allText(req.messages).includes(RETRY_MARKER),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgsGemini(true) }] },
  });

  // 5) Sub-agent — RECOVER ("luxury"), FIRST attempt (no marker) → invalid.
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        isGemini(req) && hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && !allText(req.messages).includes(RETRY_MARKER),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgsGemini(false) }] },
  });
}
