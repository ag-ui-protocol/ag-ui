import { describe, it, expect } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import {
  recoverA2UIHistory,
  preserveCompletedA2UIResults,
} from "./a2ui-history";
import fixture from "../../../../middlewares/a2ui-middleware/__tests__/fixtures/pni-568-orphan.json";

const saved = fixture as Message[];
const result: Message = {
  type: "tool",
  id: "recovery-result",
  tool_call_id: "call_25dQx1aDND8JEi4wmPYlEQ6z",
  content: '{"status":"cancelled","code":"a2ui_unanswered_call"}',
};
describe("PNI-568 native saved history", () => {
  it("places the supplied outcome before the saved follow-up, preserving all original history", () => {
    const repaired = recoverA2UIHistory(saved, [result])!;
    expect(repaired.filter((message) => message !== result)).toEqual(saved);
    const index = repaired.findIndex((message) => message === result);
    expect(repaired[index - 1]).toMatchObject({
      type: "ai",
      tool_calls: [expect.objectContaining({ id: result.tool_call_id })],
    });
    expect(repaired[index + 1]).toMatchObject({ type: "human" });
    expect(recoverA2UIHistory(repaired, [result])).toBeUndefined();
  });
  it("never invents an outcome or completes another pending tool", () => {
    expect(recoverA2UIHistory(saved, [])).toBeUndefined();
    expect(
      recoverA2UIHistory(
        [
          {
            type: "ai",
            id: "approval",
            content: "",
            tool_calls: [{ id: "pending", name: "scheduleTime", args: {} }],
          },
        ],
        [{ ...result, tool_call_id: "pending" }],
      ),
    ).toBeUndefined();
  });
  it("retains original completed IDs and contents on duplicate input", () => {
    const completed = [...saved.slice(0, -1), result, saved.at(-1)!];
    const duplicate = {
      ...result,
      id: "different-client-id",
      content: "changed",
    };
    expect(recoverA2UIHistory(completed, [duplicate])).toBeUndefined();
    expect(preserveCompletedA2UIResults(completed, [duplicate])).toEqual([]);
  });
});
