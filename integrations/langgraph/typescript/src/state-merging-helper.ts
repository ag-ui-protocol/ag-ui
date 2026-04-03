/**
 * Extracted merge-state logic for unit testing.
 *
 * This mirrors langGraphDefaultMergeState from agent.ts but doesn't require
 * a full LangGraphAgent instance with a Platform client. Used only by tests.
 */
import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";

type LangGraphToolWithName = {
  type: string;
  name?: string;
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

export function langGraphDefaultMergeState(
  state: Record<string, any>,
  messages: LangGraphMessage[],
  input: { tools?: any[]; context?: any[] },
): any {
  if (messages.length > 0 && "role" in messages[0] && messages[0].role === "system") {
    messages = messages.slice(1);
  }

  const existingMessages = state.messages || [];
  const existingMessageIds = new Set(existingMessages.map((m: any) => m.id));
  const newMessages = messages.filter((m) => !existingMessageIds.has(m.id));

  // Input tools first so they win over stale state tools on name collision
  const allTools = [...(input.tools ?? []), ...(state.tools ?? [])];
  const langGraphTools: LangGraphToolWithName[] = allTools.reduce((acc: LangGraphToolWithName[], tool: any) => {
    let mappedTool = tool;
    if (!tool.type) {
      mappedTool = {
        type: "function",
        name: tool.name,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    }

    if (
      acc.find(
        (t: LangGraphToolWithName) =>
          t.name === mappedTool.name || t.function.name === mappedTool.function?.name,
      )
    ) {
      return acc;
    }

    return [...acc, mappedTool];
  }, []);

  return {
    ...state,
    messages: newMessages,
    tools: langGraphTools,
    "ag-ui": {
      tools: langGraphTools,
      context: input.context,
    },
    copilotkit: {
      ...(state as any).copilotkit,
      actions: langGraphTools,
    },
  };
}
