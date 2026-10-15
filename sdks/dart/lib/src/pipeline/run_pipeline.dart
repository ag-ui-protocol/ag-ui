import '../client/agent.dart';
import '../generated/models.dart';

/// The run pipeline: the transport's raw events in, applied events out.
///
/// The stages are inserted here, in the order the TypeScript client runs
/// them, as each one is ported. Today: decode only.
Stream<Event> runPipeline(AbstractAgent agent, RunAgentInput input) =>
    agent.connect(input).map(Event.fromJson);
