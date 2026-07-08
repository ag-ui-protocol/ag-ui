"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useAgent,
  UseAgentUpdate,
  useConfigureSuggestions,
  useSubagent,
  CopilotChat,
  CopilotChatConfigurationProvider,
  CopilotChatAssistantMessage,
  CopilotChatReasoningMessage,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";

const AGENT_ID = "deepagents_subagents";

interface DeepagentsSubagentsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

// `subagentId` is an AG-UI message field (see @ag-ui/core) stamped by the
// integration on messages a subagent produced. It isn't part of the CopilotKit
// AssistantMessage type surface yet, so read it off the message via a cast.
function getSubagentId(message: unknown): string | undefined {
  return (message as { subagentId?: string } | null | undefined)?.subagentId;
}

type AssistantMessageProps = React.ComponentProps<
  typeof CopilotChatAssistantMessage
>;
type ChatMessage = NonNullable<AssistantMessageProps["messages"]>[number];

// Collapsible group for ONE subagent (option b): every message across the
// conversation that shares this subagentId renders inside a single expandable
// block, mirroring the reasoning UI — open while the subagent is running,
// auto-collapsing when it finishes (a manual toggle sticks). Name/description/
// status all come from `useSubagent`; the members render via the built-in
// assistant-message component so their text + tool-call cards appear inside.
function SubagentGroup({
  subagentId,
  baseProps,
}: {
  subagentId: string;
  baseProps: AssistantMessageProps;
}) {
  const subagent = useSubagent({ subagentId });
  // Subscribe to the LIVE message list. The slot is rendered inside CopilotKit's
  // MemoizedAssistantMessage, whose comparator only re-renders when the *anchor*
  // message's own content/toolCalls change — NOT when later subagent messages
  // are appended. Deriving members from the frozen `baseProps.messages` would
  // strand the group at its first-render state (one tool call). This useAgent
  // subscription re-renders the group on every message change (bypassing the
  // parent memo, since a component's own store subscription always re-renders
  // it), so all of the subagent's tool calls appear as they stream in.
  const { agent } = useAgent({
    agentId: AGENT_ID,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });
  const members = React.useMemo(
    () =>
      (agent.messages as ChatMessage[]).filter(
        (m) => m.role === "assistant" && getSubagentId(m) === subagentId,
      ),
    [agent.messages, subagentId],
  );
  // `running` reflects the SUBAGENT's own lifecycle: the registry flips it to
  // "finished" when SUBAGENT_FINISHED arrives, which the integration now emits
  // when the subagent's `task` delegation returns — not when the parent run
  // ends. So the activity indicator stops with the subagent, not the supervisor.
  const running = !subagent || subagent.status === "running";
  // Collapsed by default (like reasoning once it's done); a manual toggle wins.
  const [manualOpen, setManualOpen] = React.useState<boolean | null>(null);
  const isOpen = manualOpen ?? false;
  // Just the declared subagent name, falling back to the opaque id.
  const label = subagent?.name ?? subagentId;

  // Rendered with the exact reasoning chrome: CopilotChatReasoningMessage.Header
  // (button, muted text, ChevronRight) + .Toggle (grid-rows collapse animation).
  // A subtle pulsing dot (the same one the reasoning header uses) shows while
  // the subagent is running; it's supplied as header children because the
  // built-in pulse only renders when there's no content.
  return (
    <div className="cpk:my-1" data-testid="subagent-group">
      <CopilotChatReasoningMessage.Header
        isOpen={isOpen}
        label={label}
        hasContent
        onClick={() => setManualOpen(!isOpen)}
        title={subagent?.description ?? `Subagent ${subagentId}`}
        data-testid="subagent-tag"
      >
        {running && (
          <span
            className="cpk:inline-flex cpk:items-center cpk:ml-1"
            data-testid="subagent-activity"
          >
            <span className="cpk:w-1.5 cpk:h-1.5 cpk:rounded-full cpk:bg-muted-foreground cpk:animate-pulse" />
          </span>
        )}
      </CopilotChatReasoningMessage.Header>
      <CopilotChatReasoningMessage.Toggle isOpen={isOpen}>
        <div className="subagent-group-body">
          {members.map((m) => (
            <CopilotChatAssistantMessage
              key={m.id}
              {...baseProps}
              messages={agent.messages as AssistantMessageProps["messages"]}
              message={m as AssistantMessageProps["message"]}
            />
          ))}
        </div>
      </CopilotChatReasoningMessage.Toggle>
    </div>
  );
}

// Grouping assistant-message slot (option b). Non-subagent messages render
// normally. For a subagent message, collect every assistant message sharing its
// subagentId and render the whole set inside ONE SubagentGroup, anchored at the
// subagent's first message; later members return null (absorbed into the group).
function AssistantMessageGrouped(props: AssistantMessageProps) {
  const subagentId = getSubagentId(props.message);
  if (!subagentId) {
    return <CopilotChatAssistantMessage {...props} />;
  }
  // Anchor the group at the subagent's FIRST message so it renders exactly once;
  // later members return null (absorbed into the group, which derives its full
  // member list from the live agent state — see SubagentGroup).
  const firstOfSubagent = (props.messages ?? []).find(
    (m) => m.role === "assistant" && getSubagentId(m) === subagentId,
  );
  if (props.message.id !== firstOfSubagent?.id) {
    return null;
  }
  return <SubagentGroup subagentId={subagentId} baseProps={props} />;
}

// Wildcard tool-call renderer. CopilotKit v2 renders NOTHING for a tool call
// unless a per-tool or wildcard ("*") renderer is registered (unhandled tool
// calls are opt-in). The deepagents subagent calls generic tools (write_todos,
// grep, glob, write_file, task) with no bespoke UI, so register a catch-all that
// shows the tool name, its arguments, and result — this is what makes the
// subagent's tool-call *messages* visible under their subagent tag.
function ToolCallCard({ name, args, status, result }: {
  name: string;
  args: unknown;
  status: string;
  result?: string;
}) {
  // `task` is the supervisor's delegation tool — the subagent group itself
  // represents that delegation, so don't render a redundant task card.
  if (name === "task") {
    return null;
  }
  const argsStr =
    args && Object.keys(args as object).length > 0
      ? JSON.stringify(args, null, 2)
      : "";
  return (
    <div className="subagent-toolcall" data-testid="subagent-toolcall">
      <div className="subagent-toolcall-head">
        <span className="subagent-toolcall-name">🛠 {name}</span>
        <span className="subagent-toolcall-status">{String(status)}</span>
      </div>
      {argsStr && <pre className="subagent-toolcall-body">{argsStr}</pre>}
      {result ? (
        <pre className="subagent-toolcall-body subagent-toolcall-result">
          {result.length > 600 ? result.slice(0, 600) + "…" : result}
        </pre>
      ) : null}
    </div>
  );
}

const TOOL_CALL_RENDERERS = [
  { name: "*", render: ToolCallCard },
] as React.ComponentProps<typeof CopilotKitProvider>["renderToolCalls"];

// Stable slot object (module-level) so CopilotChat's slot memoization isn't
// defeated by a fresh reference on every render. The cast satisfies the slot's
// `typeof CopilotChatAssistantMessage` type, which carries static namespace
// members the slot renderer never uses — our wrapper is a valid replacement.
const MESSAGE_VIEW_SLOTS = {
  assistantMessage:
    AssistantMessageGrouped as unknown as typeof CopilotChatAssistantMessage,
};

export default function DeepagentsSubagents({
  params,
}: DeepagentsSubagentsProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      renderToolCalls={TOOL_CALL_RENDERERS}
    >
      <CopilotChatConfigurationProvider agentId={AGENT_ID}>
        <SubagentAttributionDemo />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

function SubagentAttributionDemo() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Run the subagents",
        message:
          "Research the topic of octopus intelligence using your subagents and summarize the findings.",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId={AGENT_ID}
          className="h-full rounded-2xl max-w-6xl mx-auto"
          messageView={MESSAGE_VIEW_SLOTS}
        />
      </div>
    </div>
  );
}
