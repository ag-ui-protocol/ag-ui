import { useAuiState } from "@assistant-ui/react";
import { useAgUiSetState, useAgUiState } from "@assistant-ui/react-ag-ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

type Task = { title: string; done: boolean };
type TaskState = { tasks: Task[] };

// Agent state, synced over STATE_SNAPSHOT / STATE_DELTA. Edits here are sent
// to the agent as `state` on the next run.
export function TaskPanel() {
  const state = useAgUiState<TaskState>();
  const setState = useAgUiSetState<TaskState>();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [draft, setDraft] = useState("");
  const tasks = state?.tasks ?? [];

  // Seed the initial state. Agents such as Agno only stream state back when
  // the run input carries some.
  useEffect(() => {
    if (state === undefined) setState({ tasks: [] });
  }, [state, setState]);

  const update = (next: Task[]) =>
    setState((prev) => ({ ...prev, tasks: next }));

  return (
    <aside className="flex max-h-56 shrink-0 flex-col gap-3 overflow-y-auto border-t border-slate-200 bg-white/80 p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l">
      <div>
        <h2 className="font-semibold">Tasks</h2>
        <p className="text-xs text-slate-500">
          Shared agent state. You and the agent can both edit it.
        </p>
      </div>
      {tasks.length === 0 && (
        <p className="text-sm text-slate-400">No tasks yet.</p>
      )}
      <ul className="space-y-1">
        {tasks.map((task, i) => (
          <li key={i} className="group flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={task.done}
                disabled={isRunning}
                onChange={() =>
                  update(
                    tasks.map((t, j) =>
                      j === i ? { ...t, done: !t.done } : t,
                    ),
                  )
                }
              />
              <span className={task.done ? "text-slate-400 line-through" : ""}>
                {task.title}
              </span>
            </label>
            <button
              type="button"
              aria-label={`Remove ${task.title}`}
              disabled={isRunning}
              onClick={() => update(tasks.filter((_, j) => j !== i))}
              className="ml-auto text-slate-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          update([...tasks, { title: draft.trim(), done: false }]);
          setDraft("");
        }}
      >
        <input
          value={draft}
          disabled={isRunning}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task"
          aria-label="Add a task"
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </form>
    </aside>
  );
}
