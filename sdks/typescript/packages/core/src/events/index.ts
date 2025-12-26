import { AgUiEvent, EventSchemas } from "../events";

export * from "../events";

export const isAgUiEvent = (value: unknown): value is AgUiEvent =>
  EventSchemas.safeParse(value).success;

export function assertAgUiEvent(value: unknown): asserts value is AgUiEvent {
  const parsed = EventSchemas.safeParse(value);
  if (!parsed.success) {
    throw parsed.error;
  }
}
