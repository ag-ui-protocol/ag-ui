import {
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, Square } from "lucide-react";

const SUGGESTIONS = [
  "What's the weather in Lisbon?",
  "Make the background a soft green",
  "Plan a weekend trip to Lisbon",
];

export function Thread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-6">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="my-auto flex flex-col items-center gap-2 py-12">
              <p className="mb-2 text-slate-500">Try one of these:</p>
              {SUGGESTIONS.map((prompt) => (
                <ThreadPrimitive.Suggestion
                  key={prompt}
                  prompt={prompt}
                  send
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50"
                >
                  {prompt}
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto mt-6 w-full max-w-2xl pb-4 pt-2">
          <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 shadow-sm">
            <ComposerPrimitive.Input
              autoFocus
              aria-label="Message"
              placeholder="Send a message…"
              rows={1}
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 outline-none"
            />
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send
                aria-label="Send"
                className="rounded-xl bg-slate-900 p-2.5 text-white disabled:opacity-30"
              >
                <ArrowUp size={18} />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel
                aria-label="Stop"
                className="rounded-xl bg-slate-900 p-2.5 text-white"
              >
                <Square size={18} />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-auto max-w-[80%] rounded-2xl bg-slate-200 px-4 py-2 whitespace-pre-wrap">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-3">
      <MessagePrimitive.Parts
        components={{
          Text: () => <MarkdownTextPrimitive className="markdown" />,
          tools: { Fallback: ToolFallback },
        }}
      />
      {/* e.g. an agent that isn't running, or a RUN_ERROR from the agent */}
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  );
}

// Tools without their own UI, such as `add_tasks`.
function ToolFallback({ toolName, result }: ToolCallMessagePartProps) {
  return (
    <p className="text-xs text-slate-400">
      {result === undefined ? `Calling ${toolName}…` : `Called ${toolName}`}
    </p>
  );
}
