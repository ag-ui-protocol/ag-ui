"use client";
import "@copilotkit/react-ui/styles.css";
import "./style.css";

import MarkdownIt from "markdown-it";
import React from "react";

import { diffWords } from "diff";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
import { CopilotKit, useCoAgent, useCopilotAction, useCopilotChat } from "@copilotkit/react-core";
import { CopilotChat, CopilotSidebar } from "@copilotkit/react-ui";
import { useMobileView } from "@/utils/use-mobile-view";
import { useMobileChat } from "@/utils/use-mobile-chat";

const extensions = [StarterKit];

interface PredictiveStateUpdatesProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function PredictiveStateUpdates({ params }: PredictiveStateUpdatesProps) {
  const { integrationId } = React.use(params);
  const { isMobile } = useMobileView();
  const defaultChatHeight = 50
  const {
    isChatOpen,
    setChatHeight,
    setIsChatOpen,
    isDragging,
    chatHeight,
    handleDragStart
  } = useMobileChat(defaultChatHeight)
  const chatTitle = 'AI Document Editor'
  const chatDescription = 'Ask me to create or edit a document'
  const initialLabel = 'Hi 👋 How can I help with your document?'

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      // agent lock to the relevant agent
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
                <div className={`transform transition-transform duration-300 ${isChatOpen ? 'rotate-180' : ''}`}>
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Pull-Up Chat Container */}
            <div
              className={`fixed inset-x-0 bottom-0 z-40 bg-white rounded-t-2xl shadow-[0px_0px_20px_0px_rgba(0,0,0,0.15)] transform transition-all duration-300 ease-in-out flex flex-col ${
                isChatOpen ? 'translate-y-0' : 'translate-y-full'
              } ${isDragging ? 'transition-none' : ''}`}
              style={{
                height: `${chatHeight}vh`,
                paddingBottom: 'env(safe-area-inset-bottom)' // Handle iPhone bottom padding
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
                    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Chat Content - Flexible container for messages and input */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden pb-16">
                <CopilotChat
                  className="h-full flex flex-col"
                  labels={{
                    initial: initialLabel,
                  }}
                />
              </div>
            </div>

            {/* Backdrop */}
            {isChatOpen && (
              <div
                className="fixed inset-0 z-30"
                onClick={() => setIsChatOpen(false)}
              />
            )}
          </>
        ) : (
          <CopilotSidebar
            defaultOpen={true}
            labels={{
              title: chatTitle,
              initial: initialLabel,
            }}
            clickOutsideToClose={false}
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
  const { isLoading } = useCopilotChat();

  const {
    state: agentState,
    setState: setAgentState,
    nodeName,
  } = useCoAgent<AgentState>({
    name: "predictive_state_updates",
    initialState: {
      document: "",
    },
  });

  useEffect(() => {
    if (isLoading) {
      setCurrentDocument(editor?.getText() || "");
    }
    editor?.setEditable(!isLoading);
  }, [isLoading]);

  useEffect(() => {
    if (nodeName == "end") {
      // set the text one final time when loading is done
      if (currentDocument.trim().length > 0 && currentDocument !== agentState?.document) {
        const newDocument = agentState?.document || "";
        const diff = diffPartialText(currentDocument, newDocument, true);
        const markdown = fromMarkdown(diff);
        editor?.commands.setContent(markdown);
      }
    }
  }, [nodeName]);

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
    setPlaceholderVisible(text.length === 0);

    if (!isLoading) {
      setCurrentDocument(text);
      setAgentState({
        document: text,
      });
    }
  }, [text]);

  // TODO(steve): Remove this when all agents have been updated to use write_document tool.
  useCopilotAction({
    name: "confirm_changes",
    renderAndWaitForResponse: ({ args, respond, status }) => (
      <ConfirmChanges
        args={args}
        respond={respond}
        status={status}
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
  });

  // Action to write the document.
  useCopilotAction({
    name: "write_document",
    description: `Present the proposed changes to the user for review`,
    parameters: [
      {
        name: "document",
        type: "string",
        description: "The full updated document in markdown format",
      },
    ],
    renderAndWaitForResponse({ args, status, respond }) {
      if (status === "executing") {
        return (
          <ConfirmChanges
            args={args}
            respond={respond}
            status={status}
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
  });

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
  args: any;
  respond: any;
  status: any;
  onReject: () => void;
  onConfirm: () => void;
}

function ConfirmChanges({ args, respond, status, onReject, onConfirm }: ConfirmChangesProps) {
  const [accepted, setAccepted] = useState<boolean | null>(null);
  return (
    <div className="bg-white p-6 rounded shadow-lg border border-gray-200 mt-5 mb-5">
      <h2 className="text-lg font-bold mb-4">Confirm Changes</h2>
      <p className="mb-6">Do you want to accept the changes?</p>
      {accepted === null && (
        <div className="flex justify-end space-x-4">
          <button
            className={`bg-gray-200 text-black py-2 px-4 rounded disabled:opacity-50 ${
              status === "executing" ? "cursor-pointer" : "cursor-default"
            }`}
            disabled={status !== "executing"}
            onClick={() => {
              if (respond) {
                setAccepted(false);
                onReject();
                respond({ accepted: false });
              }
            }}
          >
            Reject
          </button>
          <button
            className={`bg-black text-white py-2 px-4 rounded disabled:opacity-50 ${
              status === "executing" ? "cursor-pointer" : "cursor-default"
            }`}
            disabled={status !== "executing"}
            onClick={() => {
              if (respond) {
                setAccepted(true);
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
          <div className="mt-4 bg-gray-200 text-black py-2 px-4 rounded inline-block">
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
