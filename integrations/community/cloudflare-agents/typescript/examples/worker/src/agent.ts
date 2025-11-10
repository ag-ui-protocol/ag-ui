import { Agent } from "agents";

// Minimal AG-UI event set over WS (string JSON frames)
type Event = { type: string; [k: string]: unknown };
const send = (ws: WebSocket, e: Event) => ws.send(JSON.stringify(e));

// Minimal echo agent that emits AG-UI lifecycle:
// RUN_STARTED -> TEXT_MESSAGE_START -> ...CONTENT... -> TEXT_MESSAGE_END -> RUN_FINISHED
export class MyAgent extends Agent {
  onConnect(ws: WebSocket) {
    // harmless hello for sanity (AG-UI will ignore unknown events)
    send(ws, { type: "READY" });
  }

  onMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const input = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const thread_id = crypto.randomUUID();
    const run_id = crypto.randomUUID();

    send(ws, { type: "RUN_STARTED", thread_id, run_id });

    send(ws, { type: "TEXT_MESSAGE_START", role: "assistant", run_id });
    for (const chunk of ["You said: ", input]) {
      send(ws, { type: "TEXT_MESSAGE_CONTENT", delta: chunk, run_id });
    }
    send(ws, { type: "TEXT_MESSAGE_END", run_id });

    send(ws, { type: "RUN_FINISHED", run_id });
  }
}
