import {
  AbstractAgent,
  RunAgent,
  RunAgentInput,
  EventType,
  BaseEvent,
} from "@agentwire/client";
import { Observable } from "rxjs";

export class StochasticParrotAgent extends AbstractAgent {
  protected run(input: RunAgentInput): RunAgent {
    return () => {
      const messages = input.messages;
      const lastUserMessage =
        messages.findLast((msg) => msg.role === "user")?.content ||
        "My life is complicated";
      const response = StochasticParrotTherapist.completion(lastUserMessage);
      const messageId = Date.now().toString();
      return new Observable<BaseEvent>((observer) => {
        observer.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: response,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as any);

        observer.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as any);

        observer.complete();
      });
    };
  }
}

class StochasticParrotTherapist {
  public static completion(input: string): string {
    const words = input.trim().toLowerCase().split(/\s+/);

    const reflectedWords = words.map((word) => this.reflections[word] || word);

    const interjection =
      this.parrotInterjections[
        Math.floor(Math.random() * this.parrotInterjections.length)
      ];

    const question =
      this.questionPhrases[
        Math.floor(Math.random() * this.questionPhrases.length)
      ];

    return `${question} "${reflectedWords.join(" ")}"? ${interjection}`;
  }

  private static reflections: Record<string, string> = {
    am: "are",
    are: "am",
    i: "you",
    you: "I",
    me: "you",
    my: "your",
    your: "my",
    "i'm": "you are",
    im: "you are",
    myself: "yourself",
    was: "were",
    were: "was",
    "i'd": "you would",
    "i've": "you have",
    "i'll": "you will",
    "you've": "I have",
    "you'll": "I will",
  };

  private static parrotInterjections: string[] = [
    "Squawk!",
    "Pretty bird!",
    "Polly wants a cracker!",
    "Raawwkk!",
    "Hrrrrk!",
  ];

  private static questionPhrases: string[] = [
    "Why do you say",
    "Could you elaborate on why you said",
    "What makes you mention",
    "Why might you feel",
    "What's behind your statement about",
    "Tell me more about",
  ];
}
