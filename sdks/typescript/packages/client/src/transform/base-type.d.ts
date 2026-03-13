export type EventStreamParser = (source$: Observable<HttpEvent>, eventSubject: Subject<BaseEvent>) => Subscription;

export interface TransformHttpEventStreamHandlers {
  condition: (event: HttpHeadersEvent) => boolean;
  parser: EventStreamParser
}