import {
  defineToolkit,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { CloudSun } from "lucide-react";
import { useState } from "react";

type Weather = {
  location: string;
  temperature_c: number;
  conditions: string;
  humidity: number;
  wind_kph: number;
};

export const toolkit = defineToolkit({
  // Runs on the agent. The frontend only renders the call.
  get_weather: {
    type: "backend",
    render: ({ args, result }) => {
      const weather = result as Weather | undefined;
      if (!weather) {
        return (
          <p className="text-sm text-slate-500">
            Checking the weather in {args.location ?? "…"}
          </p>
        );
      }
      return (
        <div className="flex w-64 items-center gap-4 rounded-xl bg-sky-600 p-4 text-white">
          <CloudSun size={36} />
          <div>
            <p className="text-sm opacity-80">{weather.location}</p>
            <p className="text-3xl font-semibold">{weather.temperature_c}°C</p>
            <p className="text-xs opacity-80">
              {weather.conditions} · {weather.humidity}% humidity ·{" "}
              {weather.wind_kph} km/h wind
            </p>
          </div>
        </div>
      );
    },
  },

  // Sent to the agent with each run and executed in the browser.
  change_background: {
    type: "frontend",
    description: "Change the page background to a CSS color or gradient.",
    parameters: {
      type: "object",
      properties: {
        background: {
          type: "string",
          description: "Any CSS background value, e.g. '#e0f2fe'.",
        },
      },
      required: ["background"],
    },
    execute: async ({ background }) => {
      document.documentElement.style.setProperty("--app-bg", background);
      return { status: "changed" };
    },
    renderText: {
      running: "Changing the background…",
      complete: ({ args }) => `Background changed to ${args.background}`,
    },
  },

  // Pauses the run until the user answers in the rendered UI.
  approve_plan: {
    type: "human",
    description:
      "Show the user a plan and wait for them to pick which steps to keep.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Short, imperative steps.",
        },
      },
      required: ["steps"],
    },
    render: ({ args, result, status, isError, addResult }) => (
      <PlanApproval
        steps={args.steps ?? []}
        result={result as { approved?: string[] } | undefined}
        status={status}
        isError={isError}
        onSubmit={(approved) => addResult({ approved })}
      />
    ),
  },
});

function PlanApproval({
  steps,
  result,
  status,
  isError,
  onSubmit,
}: {
  steps: string[];
  result: { approved?: string[] } | undefined;
  status: ToolCallMessagePartStatus;
  isError: boolean | undefined;
  onSubmit: (approved: string[]) => void;
}) {
  const [skipped, setSkipped] = useState<Set<number>>(new Set());

  // Sending a new message while the plan is open cancels the call.
  if (isError || status.type === "incomplete") {
    return <p className="text-sm text-slate-500">Plan cancelled.</p>;
  }
  if (result?.approved) {
    return (
      <p className="text-sm text-slate-500">
        Approved {result.approved.length} of {steps.length} steps.
      </p>
    );
  }
  // Arguments are still streaming: show the steps so far, without controls.
  const awaitingUser = status.type === "requires-action";

  return (
    <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-2 font-medium">Review the plan</p>
      <ul className="space-y-1">
        {steps.map((step, i) => (
          <li key={i}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!skipped.has(i)}
                disabled={!awaitingUser}
                onChange={() => {
                  const next = new Set(skipped);
                  if (!next.delete(i)) next.add(i);
                  setSkipped(next);
                }}
              />
              {step}
            </label>
          </li>
        ))}
      </ul>
      {awaitingUser ? (
        <div className="mt-3 flex gap-2 text-sm">
          <button
            type="button"
            onClick={() => onSubmit(steps.filter((_, i) => !skipped.has(i)))}
            className="rounded-md bg-slate-900 px-3 py-1 text-white"
          >
            Approve selected
          </button>
          <button
            type="button"
            onClick={() => onSubmit([])}
            className="rounded-md border border-slate-300 px-3 py-1"
          >
            Reject
          </button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Drafting the plan…</p>
      )}
    </div>
  );
}
