import { AguiEvent } from "./types";

export class EventEncoder {
  private useSse: boolean;

  constructor(acceptHeader?: string | null) {
    this.useSse =
      !acceptHeader || acceptHeader.toLowerCase().includes("text/event-stream");
  }

  getContentType(): string {
    return this.useSse ? "text/event-stream" : "application/json";
  }

  encode(event: AguiEvent): string {
    const payload = JSON.stringify(event);
    return this.useSse ? `data: ${payload}\n\n` : `${payload}\n`;
  }
}
