import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';
import 'helpers/server_lifecycle.dart';
import 'helpers/test_helpers.dart';

void main() {
  ServerLifecycle.withServer('Simple Q&A Integration Tests', () {
    late AgUiClient agent;

    setUp(() {
      agent = TestHelpers.createTestAgent();
    });

    TestHelpers.runIntegrationTest(
      'should handle simple Q&A without tools',
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
          'simple_qa_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate event sequence
        TestHelpers.validateEventSequence(
          events,
          expectRunStarted: true,
          expectRunFinished: true,
          expectMessages: true,
        );

        // Extract and validate messages
        final messages = TestHelpers.extractMessages(events);
        expect(messages, isNotEmpty, reason: 'Should have messages');

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

        // Check for text message events
        final textEvents = events.where(
          (e) => e.eventType == EventType.textMessageChunk ||
                 e.eventType == EventType.textMessageContent,
        ).toList();

        expect(
          textEvents,
          isNotEmpty,
          reason: 'Should have text message streaming events',
        );

        // Verify streaming order
        bool foundRunStarted = false;
        bool foundMessages = false;
        bool foundTextParts = false;

        for (final event in events) {
          if (event.eventType == EventType.runStarted) {
            foundRunStarted = true;
            expect(
              foundMessages,
              isFalse,
              reason: 'RUN_STARTED should come before messages',
            );
          } else if (event.eventType == EventType.messagesSnapshot ||
                     event.eventType == EventType.messagesSnapshot) {
            foundMessages = true;
            expect(
              foundRunStarted,
              isTrue,
              reason: 'Messages should come after RUN_STARTED',
            );
          } else if (event.eventType == EventType.textMessageChunk ||
                     event.eventType == EventType.textMessageContent) {
            foundTextParts = true;
            expect(
              foundRunStarted,
              isTrue,
              reason: 'Text parts should come after RUN_STARTED',
            );
          } else if (event.eventType == EventType.runFinished) {
            expect(
              foundRunStarted,
              isTrue,
              reason: 'RUN_FINISHED should come after RUN_STARTED',
            );
          }
        }

        expect(foundRunStarted, isTrue, reason: 'Should have RUN_STARTED');
        expect(foundMessages, isTrue, reason: 'Should have messages');
        
        print('Simple Q&A test completed successfully');
        print('Total events received: ${events.length}');
        print('Assistant messages: ${assistantMessages.length}');
        print('Text streaming events: ${textEvents.length}');
      },
    );

    TestHelpers.runIntegrationTest(
      'should handle deterministic prompt with streaming',
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
          'deterministic_qa_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate basic structure
        TestHelpers.validateEventSequence(events);

        // Extract messages
        final messages = TestHelpers.extractMessages(events);
        final assistantMessages = messages.where(
          (m) => m.role == MessageRole.assistant,
        ).toList();

        expect(
          assistantMessages,
          isNotEmpty,
          reason: 'Should have assistant response',
        );

        // Check that response contains expected text
        final responseContent = assistantMessages.first.content ?? '';
        expect(
          responseContent.toLowerCase(),
          contains('hello'),
          reason: 'Response should contain "Hello"',
        );

        print('Deterministic prompt test completed');
        print('Response: $responseContent');
      },
    );
  });
}