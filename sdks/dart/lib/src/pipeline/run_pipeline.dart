import '../client/agent.dart';
import '../generated/models.dart';
import 'compat/boundary.dart';
import 'enforce.dart';
import 'era/select.dart';

/// The run pipeline: the request out through the era shims, the transport's
/// raw events back in through the compatibility boundary, the era shims,
/// enforcement, chunk expansion, verification and application — the stages
/// the TypeScript client runs, in the order it runs them.
///
/// Stages still to port are added here and nowhere else.
Stream<Event> runPipeline(AbstractAgent agent, RunAgentInput input) {
  final shims = selectEraShims(agent.maxProtocolVersion);
  var request = input;
  for (final shim in shims.outgoing) {
    request = shim(request, agent.onWarning);
  }
  var raw = CompatibilityBoundary(agent.onWarning)(agent.connect(request));
  for (final shim in shims.inbound) {
    raw = shim(raw, agent.onWarning);
  }
  return enforceEvents(raw, agent.onWarning);
}
