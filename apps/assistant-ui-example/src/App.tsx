import { HttpAgent } from "@ag-ui/client";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
} from "@assistant-ui/react";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { useMemo, useState } from "react";
import { TaskPanel } from "./TaskPanel";
import { Thread } from "./Thread";
import { toolkit } from "./tools";

// Both agents serve the same tools, so one frontend talks to either.
const BACKENDS = {
  "Pydantic AI":
    import.meta.env.VITE_PYDANTIC_AI_URL ?? "http://localhost:8105/",
  Agno: import.meta.env.VITE_AGNO_URL ?? "http://localhost:8115/agui",
};

type Backend = keyof typeof BACKENDS;

export function App() {
  const [backend, setBackend] = useState<Backend>("Pydantic AI");

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3">
        <h1 className="font-semibold text-slate-900">assistant-ui + AG-UI</h1>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(Object.keys(BACKENDS) as Backend[]).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={backend === name}
              onClick={() => setBackend(name)}
              className={`rounded-md px-3 py-1 ${
                backend === name ? "bg-white shadow-sm" : "text-slate-500"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </header>
      {/* A new key starts a fresh thread when the backend changes. */}
      <Chat key={backend} url={BACKENDS[backend]} />
    </div>
  );
}

function Chat({ url }: { url: string }) {
  const agent = useMemo(() => new HttpAgent({ url }), [url]);
  const runtime = useAgUiRuntime({ agent });
  const config = AuiConfig({ tools: Tools({ toolkit }) });

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="flex min-h-0 flex-1 flex-col">
          <Thread />
        </main>
        <TaskPanel />
      </div>
    </AssistantRuntimeProvider>
  );
}
