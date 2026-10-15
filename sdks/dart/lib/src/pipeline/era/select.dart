import '../../client/warnings.dart';
import '../../generated/models.dart';
import '../versions.dart';
import 'era_0_0_39.dart';
import 'era_0_0_45.dart';
import 'era_0_0_57.dart';

/// A request transform, applied before the transport sends it.
typedef OutgoingShim =
    RunAgentInput Function(RunAgentInput input, WarningSink warn);

/// A raw event-stream transform, applied after the compatibility boundary.
typedef InboundShim =
    Stream<Map<String, Object?>> Function(
      Stream<Map<String, Object?>> source,
      WarningSink warn,
    );

/// The era shims a peer ceiling installs, in application order.
final class EraShims {
  const EraShims({required this.outgoing, required this.inbound});

  /// Applied to the request in this order.
  final List<OutgoingShim> outgoing;

  /// Applied to the raw stream in this order, innermost first.
  final List<InboundShim> inbound;

  static const none = EraShims(outgoing: [], inbound: []);
}

/// The shims for a peer whose ceiling is [maxProtocolVersion]: each era at
/// or below the ceiling is installed. Null is a current peer and gets none.
///
/// Order mirrors the TypeScript client, where each shim is prepended to the
/// middleware chain in ascending order so 0.0.57 ends up outermost: the
/// request passes 0.0.57 before 0.0.39, and events pass 0.0.45 before 0.0.57.
EraShims selectEraShims(String? maxProtocolVersion) {
  if (maxProtocolVersion == null) return EraShims.none;
  bool atOrBelow(String era) =>
      compareProtocolVersions(maxProtocolVersion, era) <= 0;
  return EraShims(
    outgoing: [
      if (atOrBelow('0.0.57')) stripSubagentsFor0057,
      if (atOrBelow('0.0.39')) flattenContentFor0039,
    ],
    inbound: [
      if (atOrBelow('0.0.45')) translateThinkingFor0045,
      if (atOrBelow('0.0.57')) dropSubagentsFor0057,
    ],
  );
}
