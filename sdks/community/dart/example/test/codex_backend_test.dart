import 'package:ag_ui_example/models/endpoint_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Codex mode exposes only tool-free chat with retained history', () {
    final endpoints = EndpointConfig.endpointsFor('codex');
    expect(endpoints, hasLength(1));
    expect(endpoints.single.path, 'agentic_chat');
    expect(endpoints.single.featureKind, FeatureKind.clientTools);
    expect(endpoints.single.tools, isEmpty);
    expect(endpoints.single.isMultimodal, isFalse);
  });

  test('default backend keeps every Go endpoint and frontend tool', () {
    final endpoints = EndpointConfig.endpointsFor('go');
    expect(endpoints.map((endpoint) => endpoint.path), [
      'agentic_chat',
      'human_in_the_loop',
      'agentic_generative_ui',
      'tool_based_generative_ui',
      'shared_state',
      'predictive_state_updates',
      'image-gen',
      'vision',
      'audio',
      'document',
    ]);
    expect(endpoints.first.tools.map((tool) => tool.name), [
      'get_current_time',
      'calculate',
    ]);
    expect(EndpointConfig.endpointsFor(''), same(EndpointConfig.goEndpoints));
    expect(EndpointConfig.backend, 'go');
  });
}
