import type { Tool } from "@ag-ui/core";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

// Pi also accepts globs and +/- modifiers in its list of active tool names.
const clientName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const builtinNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

export function createClientTools(
  definitions: readonly Tool[],
  reservedNames: Iterable<string> = [],
): { tools: ToolDefinition[]; pending: ReadonlySet<string>; bind(session: AgentSession): void } {
  const names = new Set([...builtinNames, ...reservedNames]);
  const pending = new Set<string>();
  const tools: ToolDefinition[] = definitions.map(({ name, description, parameters }) => {
    if (
      !clientName.test(name) ||
      names.has(name) ||
      name === "prototype" ||
      Object.hasOwn(Object.prototype, name)
    ) {
      throw new Error("Invalid or conflicting client tool name");
    }
    names.add(name);
    if (
      parameters !== undefined &&
      (parameters === null || Array.isArray(parameters) || typeof parameters !== "object")
    ) {
      throw new Error("Expected an object for the client tool parameter schema");
    }
    return {
      name,
      description,
      label: name,
      parameters: parameters ?? { type: "object", properties: {} },
      async execute(id) {
        pending.add(id);
        // Pi requires a native result. The example withholds it while the client supplies the real one.
        return { content: [], details: {}, terminate: true };
      },
    };
  });

  function bind(session: AgentSession) {
    if (!tools.length) return;
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      // Pi honors terminate on a tool batch only when every tool requests it.
      return pending.size ? { action: "end" } : (decision ?? undefined);
    };
  }
  return { tools, pending, bind };
}
