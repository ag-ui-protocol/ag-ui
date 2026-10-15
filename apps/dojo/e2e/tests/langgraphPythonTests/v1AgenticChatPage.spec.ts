import { test } from "../../event-trace-test";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";
import { v1AgenticChatPageEventTrace as defaultEventTrace } from "./v1AgenticChatPage.event-trace";
import { v1AgenticChatPageEventTrace as v2EventTrace } from "./v2/v1AgenticChatPage.event-trace";
const v1AgenticChatPageEventTrace =
  process.env.LANGGRAPH_TRACE_REFERENCE === "v2"
    ? v2EventTrace
    : defaultEventTrace;

test("[V1] LangGraph Python sends and receives a message", async ({
  page,
  eventTrace,
}) => {
  const chat = new V1AgenticChatPage(page);
  await chat.openWithAgentConnection(
    "/langgraph/feature/v1_agentic_chat",
    "/api/copilotkit/langgraph",
  );
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);
  await eventTrace.expectJourney(
    v1AgenticChatPageEventTrace.langgraphPythonSendsAndReceivesAMessage,
  );
});
