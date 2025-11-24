import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { A2AChatPage } from "../../pages/a2aMiddlewarePages/A2AChatPage";

test.describe("A2A Chat Feature", () => {
  test("[A2A Middleware] Tab bar exists", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      await page.goto(
        "/a2a-middleware/feature/a2a_chat"
      );

      const chat = new A2AChatPage(page);

      await chat.openChat();
      // This should already be handled previously but we just need a base case
      await chat.mainChatTab.waitFor({ state: "visible" });
    });
  });
});