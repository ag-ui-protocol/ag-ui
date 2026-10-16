import { test, expect } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { A2AChatPage } from "../../pages/a2aMiddlewarePages/A2AChatPage";
import {
  A2A_DELEGATION_PROMPT,
  A2A_FINANCE_REPLY,
  A2A_FINANCE_TASK,
} from "../../a2a-middleware-fixtures";

test.describe("A2A Chat Feature", () => {
  test("[A2A Middleware] delegates a task to a department agent over A2A and relays the reply", async ({
    page,
  }) => {
    await gotoAndAwaitRuntimeInfo(page, "/a2a/feature/a2a_chat");

    const a2a = new A2AChatPage(page);
    await a2a.openChat();

    const chat = new AgenticChatPage(page);
    await chat.sendMessage(A2A_DELEGATION_PROMPT);
    await chat.assertUserMessageVisible(A2A_DELEGATION_PROMPT);

    // The orchestrator's delegation, rendered from the send_message_to_a2a_agent call.
    await expect(page.getByText(A2A_FINANCE_TASK)).toBeVisible({ timeout: 30000 });
    // The Finance Agent's answer, which only exists in its A2A server's reply.
    await expect(page.getByText(A2A_FINANCE_REPLY).first()).toBeVisible({ timeout: 30000 });
    // The orchestrator's final answer, built from that tool result.
    await chat.assertAgentReplyVisible(/The Finance Agent replied: .*FIN-4242/);
  });
});
