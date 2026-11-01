import {
  createOpencodeClient,
  type Event,
  type Message,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk/v2";

export interface OpenCodeTransport {
  create(signal: AbortSignal): Promise<string>;
  subscribe(signal: AbortSignal): Promise<AsyncIterable<Event>>;
  prompt(
    sessionID: string,
    messageID: string,
    text: string,
    signal: AbortSignal,
    system?: string,
  ): Promise<void>;
  messages(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<Array<{ info: Message; parts: Part[] }>>;
  abort(sessionID: string): Promise<void>;
  permissions(signal: AbortSignal): Promise<PermissionRequest[]>;
  questions(signal: AbortSignal): Promise<QuestionRequest[]>;
  replyPermission(
    id: string,
    reply: "once" | "always" | "reject",
    signal: AbortSignal,
  ): Promise<void>;
  replyQuestion(
    id: string,
    answers: string[][] | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface TransportOptions {
  baseUrl: string;
  directory: string;
  headers?: OpencodeClientConfig["headers"];
  model?: { providerID: string; modelID: string };
}
export function createSdkTransport(
  options: TransportOptions,
): OpenCodeTransport {
  const client = createOpencodeClient({
    baseUrl: options.baseUrl,
    directory: options.directory,
    headers: options.headers,
  });
  const directory = options.directory;
  return {
    async create(signal) {
      const result = await client.session.create(
        { directory, title: "AG-UI conversation" },
        { signal, throwOnError: true },
      );
      return result.data.id;
    },
    async subscribe(signal) {
      const { stream } = await client.event.subscribe(
        { directory },
        { signal, sseMaxRetryAttempts: 1 },
      );
      // The SDK stream is lazy: awaiting subscribe alone does NOT establish a subscription.
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== "server.connected")
        throw new Error("OpenCode subscription handshake failed");
      return { [Symbol.asyncIterator]: () => iterator };
    },
    async prompt(sessionID, messageID, text, signal, system) {
      await client.session.promptAsync(
        {
          directory,
          sessionID,
          messageID,
          model: options.model,
          system,
          parts: [{ type: "text", text }],
        },
        { signal, throwOnError: true },
      );
    },
    async messages(sessionID, signal) {
      return (
        await client.session.messages(
          { directory, sessionID },
          { signal, throwOnError: true },
        )
      ).data;
    },
    async abort(sessionID) {
      await client.session.abort(
        { directory, sessionID },
        { signal: AbortSignal.timeout(5000), throwOnError: true },
      );
    },
    async permissions(signal) {
      return (
        await client.permission.list(
          { directory },
          { signal, throwOnError: true },
        )
      ).data;
    },
    async questions(signal) {
      return (
        await client.question.list(
          { directory },
          { signal, throwOnError: true },
        )
      ).data;
    },
    async replyPermission(requestID, reply, signal) {
      await client.permission.reply(
        { directory, requestID, reply },
        { signal, throwOnError: true },
      );
    },
    async replyQuestion(requestID, answers, signal) {
      if (answers)
        await client.question.reply(
          { directory, requestID, answers },
          { signal, throwOnError: true },
        );
      else
        await client.question.reject(
          { directory, requestID },
          { signal, throwOnError: true },
        );
    },
  };
}
