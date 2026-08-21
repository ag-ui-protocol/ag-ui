"use client";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";

import MarkdownIt from "markdown-it";
import React from "react";

import { diffWords } from "diff";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState, useRef } from "react";
import { 
  useAgent,
  UseAgentUpdate,
  useHumanInTheLoop,
  useConfigureSuggestions,
  CopilotChat,
  CopilotSidebar,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useMobileView } from "@/utils/use-mobile-view";
import { useMobileChat } from "@/utils/use-mobile-chat";
import { useURLParams } from "@/contexts/url-params-context";
import { CopilotKit } from "@copilotkit/react-core";

const extensions = [StarterKit];

interface PredictiveStateUpdatesProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function PredictiveStateUpdates({ params }: PredictiveStateUpdatesProps) {
  const { integrationId } = React.use(params);
  const { isMobile } = useMobileView();
  const { chatDefaultOpen } = useURLParams();
  const defaultChatHeight = 50;
  const { isChatOpen, setChatHeight, setIsChatOpen, isDragging, chatHeight, handleDragStart } =
    useMobileChat(defaultChatHeight);
  const chatTitle = "AI Document Editor";
  const chatDescription = "Ask me to create or edit a document";

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="predictive_state_updates"
    >
      <div
        className="min-h-screen w-full"
        style={
          {
            // "--copilot-kit-primary-color": "#222",
            // "--copilot-kit-separator-color": "#CCC",
          } as React.CSSProperties
        }
      >
        {isMobile ? (
          <>
            {/* Chat Toggle Button */}
            <div className="fixed bottom-0 left-0 right-0 z-50">
              <div className="bg-gradient-to-t from-white via-white to-transparent h-6"></div>
              <div
                className="bg-white border-t border-gray-200 px-4 py-3 flex items-center justify-between cursor-pointer shadow-lg"
                onClick={() => {
                  if (!isChatOpen) {
                    setChatHeight(defaultChatHeight); // Reset to good default when opening
                  }
                  setIsChatOpen(!isChatOpen);
                }}
              >
                <div className="flex items-center gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{chatTitle}</div>
                    <div className="text-sm text-gray-500">{chatDescription}</div>
                  </div>
                </div>
                <div
                  className={`transform transition-transform duration-300 ${isChatOpen ? "rotate-180" : ""}`}
                >
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </div>
              </div>
            </div>

            {/* Pull-Up Chat Container */}
            <div
              className={`fixed inset-x-0 bottom-0 z-40 bg-white rounded-t-2xl shadow-[0px_0px_20px_0px_rgba(0,0,0,0.15)] transform transition-all duration-300 ease-in-out flex flex-col ${
                isChatOpen ? "translate-y-0" : "translate-y-full"
              } ${isDragging ? "transition-none" : ""}`}
              style={{
                height: `${chatHeight}vh`,
                paddingBottom: "env(safe-area-inset-bottom)", // Handle iPhone bottom padding
              }}
            >
              {/* Drag Handle Bar */}
              <div
                className="flex justify-center pt-3 pb-2 flex-shrink-0 cursor-grab active:cursor-grabbing"
                onMouseDown={handleDragStart}
              >
                <div className="w-12 h-1 bg-gray-400 rounded-full hover:bg-gray-500 transition-colors"></div>
              </div>

              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{chatTitle}</h3>
                  </div>
                  <button
                    onClick={() => setIsChatOpen(false)}
                    className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  >
                    <svg
                      className="w-5 h-5 text-gray-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Chat Content - Flexible container for messages and input */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden pb-16">
                <CopilotChat
                  agentId="predictive_state_updates"
                  className="h-full flex flex-col"
                />
              </div>
            </div>

            {/* Backdrop */}
            {isChatOpen && (
              <div className="fixed inset-0 z-30" onClick={() => setIsChatOpen(false)} />
            )}
          </>
        ) : (
          <CopilotSidebar
            agentId="predictive_state_updates"
            defaultOpen={chatDefaultOpen}
            labels={{
              modalHeaderTitle: chatTitle,
            }}
          />
        )}
        <DocumentEditor />
      </div>
    </CopilotKit>
  );
}

interface AgentState {
  document: string;
}

const DocumentEditor = () => {
  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "min-h-screen p-10" },
    },
  });
  const [placeholderVisible, setPlaceholderVisible] = useState(false);
  const [currentDocument, setCurrentDocument] = useState("");
  // Which proposals the user has already answered, keyed by the tool call each
  // one belongs to. This lives here rather than inside the card because the
  // card is rebuilt whenever the document in shared state changes, and a
  // decision held inside it would be erased by the very write that records it.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const recordDecision = (toolCallId: string, accepted: boolean) =>
    setDecisions((prev) => ({ ...prev, [toolCallId]: accepted }));

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Write a pirate story",
        message: "Please write a story about a pirate named Candy Beard.",
      },
      {
        title: "Write a mermaid story",
        message: "Please write a story about a mermaid named Luna.",
      },
      { title: "Add character", message: "Please add a character named Courage." },
    ],
    available: "always",
  });

  const { agent } = useAgent({
    agentId: "predictive_state_updates",
    updates: [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnRunStatusChanged],
  });

  const agentState = agent.state as AgentState | undefined;
  const setAgentState = (s: AgentState) => agent.setState(s);
  const isLoading = agent.isRunning;

  // Track when a run transitions from running to not running (replaces nodeName == "end")
  const wasRunning = useRef(false);

  // NOTE (PNI-272): these effects read from the TipTap editor across the run
  // lifecycle and are kept exactly as they were; the rule's remedy would change
  // commit timing and the editor integration's shape.
  useEffect(() => {
    if (isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentDocument(editor?.getText() || "");
    }
    editor?.setEditable(!isLoading);
  }, [isLoading]);

  useEffect(() => {
    if (wasRunning.current && !isLoading) {
      // Run just finished - set the text one final time
      if (currentDocument.trim().length > 0 && currentDocument !== agentState?.document) {
        const newDocument = agentState?.document || "";
        const diff = diffPartialText(currentDocument, newDocument, true);
        const markdown = fromMarkdown(diff);
        editor?.commands.setContent(markdown);
      }
    }
    wasRunning.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    if (isLoading) {
      if (currentDocument.trim().length > 0) {
        const newDocument = agentState?.document || "";
        const diff = diffPartialText(currentDocument, newDocument);
        const markdown = fromMarkdown(diff);
        editor?.commands.setContent(markdown);
      } else {
        const markdown = fromMarkdown(agentState?.document || "");
        editor?.commands.setContent(markdown);
      }
    }
  }, [agentState?.document]);

  const text = editor?.getText() || "";

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaceholderVisible(text.length === 0);

    // Only adopt the editor's text as the document when the editor is showing a
    // DOCUMENT. While a change is proposed it shows a DIFF instead, insertions in
    // <em> and deletions in <s>, and reading that as text flattens the markup: a
    // struck-out "Atlantis" beside an inserted "Lola" becomes the literal word
    // "AtlantisLola". Adopting that made it both the stored document and the text
    // a rejection restored. The window is open because a run ENDS while the
    // proposal waits, the tool that asks the user being owned by the browser.
    // Italic and strike-through are reserved for diffs here, which is what makes
    // their presence a reliable signal (the agent is told not to emit them).
    const showsDiff = /<(?:s|em)[\s>/]/.test(editor?.getHTML() ?? "");

    if (!isLoading && !showsDiff) {
      setCurrentDocument(text);
      setAgentState({
        document: text,
      });
    }
  }, [text]);

  // TODO(steve): Remove this when all agents have been updated to use write_document tool.
  useHumanInTheLoop(
    {
      agentId: "predictive_state_updates",
      name: "confirm_changes",
      render: ({ args, respond, status, toolCallId }) => (
        <ConfirmChanges
          args={args}
          respond={respond}
          status={status}
          decided={decisions[toolCallId]}
          onDecide={(accepted) => recordDecision(toolCallId, accepted)}
          onReject={() => {
            editor?.commands.setContent(fromMarkdown(currentDocument));
            setAgentState({ document: currentDocument });
          }}
          onConfirm={() => {
            editor?.commands.setContent(fromMarkdown(agentState?.document || ""));
            setCurrentDocument(agentState?.document || "");
            setAgentState({ document: agentState?.document || "" });
          }}
        />
      ),
    },
    [agentState?.document, decisions],
  );

  // Action to write the document.
  useHumanInTheLoop(
    {
      agentId: "predictive_state_updates",
      name: "write_document",
      description: `Present the proposed changes to the user for review`,
       parameters: z.object({
        document: z.string().describe("The full updated document in markdown format"),
      }) ,
      render({ args, status, respond, toolCallId }: { args: { document?: string }; status: string; respond?: (result: unknown) => Promise<void>; toolCallId: string }) {
        if (status === "executing") {
          return (
            <ConfirmChanges
              args={args}
              respond={respond}
              status={status}
              decided={decisions[toolCallId]}
              onDecide={(accepted) => recordDecision(toolCallId, accepted)}
              onReject={() => {
                editor?.commands.setContent(fromMarkdown(currentDocument));
                setAgentState({ document: currentDocument });
              }}
              onConfirm={() => {
                editor?.commands.setContent(fromMarkdown(agentState?.document || ""));
                setCurrentDocument(agentState?.document || "");
                setAgentState({ document: agentState?.document || "" });
              }}
            />
          );
        }
        return <></>;
      },
    },
    [agentState?.document, decisions],
  );

  return (
    <div className="relative min-h-screen w-full">
      {placeholderVisible && (
        <div className="absolute top-6 left-6 m-4 pointer-events-none text-gray-400">
          Write whatever you want here in Markdown format...
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
};

interface ConfirmChangesProps {
  args: { document?: string };
  respond?: (result: unknown) => Promise<void>;
  status: string;
  /** The answer already given for this tool call, or undefined if unanswered. */
  decided?: boolean;
  onDecide: (accepted: boolean) => void;
  onReject: () => void;
  onConfirm: () => void;
}

function ConfirmChanges({ args: _args, respond, status, decided, onDecide, onReject, onConfirm }: ConfirmChangesProps) {
  // Read from the parent rather than from local state: this component is rebuilt
  // whenever the document in shared state changes, and answering causes exactly
  // that, so a local answer would be discarded the moment it was given.
  const accepted = decided ?? null;
  return (
    <div
      data-testid="confirm-changes-modal"
      className="bg-white p-6 rounded shadow-lg border border-gray-200 mt-5 mb-5"
    >
      <h2 className="text-lg font-bold mb-4">Confirm Changes</h2>
      <p className="mb-6">Do you want to accept the changes?</p>
      {accepted === null && (
        <div className="flex justify-end space-x-4">
          <button
            data-testid="reject-button"
            className={`bg-gray-200 text-black py-2 px-4 rounded disabled:opacity-50 ${
              status === "executing" ? "cursor-pointer" : "cursor-default"
            }`}
            disabled={status !== "executing"}
            onClick={() => {
              if (respond) {
                onDecide(false);
                onReject();
                respond({ accepted: false });
              }
            }}
          >
            Reject
          </button>
          <button
            data-testid="confirm-button"
            className={`bg-black text-white py-2 px-4 rounded disabled:opacity-50 ${
              status === "executing" ? "cursor-pointer" : "cursor-default"
            }`}
            disabled={status !== "executing"}
            onClick={() => {
              if (respond) {
                onDecide(true);
                onConfirm();
                respond({ accepted: true });
              }
            }}
          >
            Confirm
          </button>
        </div>
      )}
      {accepted !== null && (
        <div className="flex justify-end">
          <div
            data-testid="status-display"
            className="mt-4 bg-gray-200 text-black py-2 px-4 rounded inline-block"
          >
            {accepted ? "✓ Accepted" : "✗ Rejected"}
          </div>
        </div>
      )}
    </div>
  );
}

function fromMarkdown(text: string) {
  const md = new MarkdownIt({
    typographer: true,
    html: true,
  });

  return md.render(text);
}

function diffPartialText(oldText: string, newText: string, isComplete: boolean = false) {
  let oldTextToCompare = oldText;
  if (oldText.length > newText.length && !isComplete) {
    // make oldText shorter
    oldTextToCompare = oldText.slice(0, newText.length);
  }

  const changes = diffWords(oldTextToCompare, newText);

  let result = "";
  changes.forEach((part) => {
    if (part.added) {
      result += `<em>${part.value}</em>`;
    } else if (part.removed) {
      result += `<s>${part.value}</s>`;
    } else {
      result += part.value;
    }
  });

  if (oldText.length > newText.length && !isComplete) {
    result += oldText.slice(newText.length);
  }

  return result;
}

function isAlpha(text: string) {
  return /[a-zA-Z\u00C0-\u017F]/.test(text.trim());
}
