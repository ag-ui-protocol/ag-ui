import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';
import 'helpers/docker_server_lifecycle.dart';
import 'helpers/test_helpers.dart';

void main() {
  DockerServerLifecycle.withServer('Simple Q&A Integration Tests (Docker)', () {
    late AgUiClient agent;

    setUp(() {
      // Use port 8000 for Docker server
      agent = TestHelpers.createTestAgent(
        baseUrl: 'http://127.0.0.1:8000',
      );
    });

    TestHelpers.runIntegrationTest(
      'should handle simple Q&A without tools via Docker server',
      () async {
        // Create input for simple Q&A
        final input = TestHelpers.createTestInput(
          messages: [
            UserMessage(
              id: 'msg-1',
              content: 'What is the capital of France?',
            ),
          ],
        );

        // Run the agent - using agentic_chat endpoint for simple Q&A
        final eventStream = agent.runAgent(
          'agentic_chat',
          input,
        );

        // Collect all events
        final events = await TestHelpers.collectEvents(
          eventStream,
          timeout: const Duration(seconds: 20),
        );

        // Save transcript for debugging
        await TestHelpers.saveTranscript(
          events,
          'docker_simple_qa_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate event sequence
        TestHelpers.validateEventSequence(
          events,
          expectRunStarted: true,
          expectRunFinished: true,
          expectMessages: true,
        );

        // Check for text message events
        final textEvents = events.where(
          (e) => e.eventType == EventType.textMessageStart ||
                 e.eventType == EventType.textMessageContent ||
                 e.eventType == EventType.textMessageEnd,
        ).toList();

        expect(
          textEvents,
          isNotEmpty,
          reason: 'Should have text message events',
        );

        // Extract messages if available (might be using streaming instead of snapshots)
        final messages = TestHelpers.extractMessages(events);
        
        // If using snapshot pattern, verify messages
        if (messages.isNotEmpty) {
          // Find assistant response
          final assistantMessages = messages.where(
            (m) => m.role == MessageRole.assistant,
          ).toList();
          
          expect(
            assistantMessages,
            isNotEmpty,
            reason: 'Should have assistant response',
          );

          // Verify no tool calls in simple Q&A
          final toolCalls = TestHelpers.findToolCalls(messages);
          expect(
            toolCalls,
            isEmpty,
            reason: 'Simple Q&A should not have tool calls',
          );
        }

        print('Docker Simple Q&A test completed successfully');
        print('Total events received: ${events.length}');
        print('Text message events: ${textEvents.length}');
      },
    );

    TestHelpers.runIntegrationTest(
      'should handle deterministic prompt with streaming via Docker',
      () async {
        // Use a more deterministic prompt
        final input = TestHelpers.createTestInput(
          messages: [
            UserMessage(
              id: 'msg-1',
              content: 'Say exactly: "Hello, World!" and nothing else.',
            ),
          ],
        );

        // Run the agent
        final eventStream = agent.runAgent(
          'agentic_chat',
          input,
        );

        // Collect all events
        final events = await TestHelpers.collectEvents(
          eventStream,
          timeout: const Duration(seconds: 15),
        );

        // Save transcript
        await TestHelpers.saveTranscript(
          events,
          'docker_deterministic_qa_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate basic structure
        TestHelpers.validateEventSequence(events);

        // Check for text message events
        final textEvents = events.where(
          (e) => e.eventType == EventType.textMessageStart ||
                 e.eventType == EventType.textMessageContent ||
                 e.eventType == EventType.textMessageEnd,
        ).toList();

        expect(
          textEvents,
          isNotEmpty,
          reason: 'Should have text message events',
        );

        // Extract messages if available
        final messages = TestHelpers.extractMessages(events);
        
        // If we got message snapshots, verify content
        if (messages.isNotEmpty) {
          final assistantMessages = messages.where(
            (m) => m.role == MessageRole.assistant,
          ).toList();

          if (assistantMessages.isNotEmpty) {
            // Check that response contains expected text
            final responseContent = assistantMessages.first.content ?? '';
            expect(
              responseContent.toLowerCase(),
              contains('hello'),
              reason: 'Response should contain "Hello"',
            );
            print('Response content: $responseContent');
          }
        }

        print('Docker deterministic prompt test completed');
        print('Total events: ${events.length}');
        print('Text events: ${textEvents.length}');
      },
    );
  });
}