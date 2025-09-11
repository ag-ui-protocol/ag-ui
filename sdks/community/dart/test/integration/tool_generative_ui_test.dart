import 'dart:convert';
import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';
import 'helpers/server_lifecycle.dart';
import 'helpers/test_helpers.dart';

void main() {
  ServerLifecycle.withServer('Tool-Based Generative UI Integration Tests', () {
    late AgUiClient agent;

    setUp(() {
      agent = TestHelpers.createTestAgent();
    });

    TestHelpers.runIntegrationTest(
      'should handle tool-based generative UI flow',
      () async {
        // Create input to trigger tool call
        final input = TestHelpers.createTestInput(
          messages: [
            UserMessage(
              id: 'msg-1',
              content: 'Generate a haiku about AI',
            ),
          ],
        );

        // Run the agent with tool_based_generative_ui endpoint
        final eventStream = agent.runAgent(
          'tool_based_generative_ui',
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
          'tool_generative_ui_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate event sequence
        TestHelpers.validateEventSequence(
          events,
          expectRunStarted: true,
          expectRunFinished: true,
          expectMessages: true,
        );

        // Extract messages
        final messages = TestHelpers.extractMessages(events);
        expect(messages, isNotEmpty, reason: 'Should have messages');

        // Find tool calls
        final toolCalls = TestHelpers.findToolCalls(messages);
        expect(
          toolCalls,
          isNotEmpty,
          reason: 'Should have tool calls for generative UI',
        );

        // Verify tool call details
        final firstToolCall = toolCalls.first;
        expect(
          firstToolCall.function.name,
          equals('generate_haiku'),
          reason: 'Tool should be generate_haiku',
        );

        // Parse and validate tool arguments
        final arguments = jsonDecode(firstToolCall.function.arguments);
        expect(
          arguments,
          containsPair('japanese', isA<List>()),
          reason: 'Should have Japanese haiku lines',
        );
        expect(
          arguments,
          containsPair('english', isA<List>()),
          reason: 'Should have English haiku lines',
        );

        // Check for tool call events
        final toolCallEvents = events.where(
          (e) => e.eventType == EventType.toolCallStart ||
                 e.eventType == EventType.toolCallArgs ||
                 e.eventType == EventType.toolCallEnd,
        ).toList();

        expect(
          toolCallEvents,
          isNotEmpty,
          reason: 'Should have TOOL_CALL events',
        );

        // Find tool result messages
        final toolResultMessages = messages.where(
          (m) => m.role == MessageRole.tool,
        ).toList();

        expect(
          toolResultMessages,
          isNotEmpty,
          reason: 'Should have tool result messages',
        );

        // Verify tool result content
        final toolResult = toolResultMessages.first;
        expect(
          toolResult.content,
          equals('Haiku created'),
          reason: 'Tool result should indicate haiku creation',
        );

        print('Tool generative UI test completed successfully');
        print('Total events: ${events.length}');
        print('Tool calls found: ${toolCalls.length}');
        print('Tool call name: ${firstToolCall.function.name}');
      },
    );

    TestHelpers.runIntegrationTest(
      'should handle tool results round-trip',
      () async {
        // First request to get tool call
        final initialInput = TestHelpers.createTestInput(
          messages: [
            UserMessage(
              id: 'msg-1',
              content: 'Create a haiku',
            ),
          ],
        );

        // Run first request
        final firstStream = agent.runAgent(
          'tool_based_generative_ui',
          initialInput,
        );

        final firstEvents = await TestHelpers.collectEvents(firstStream);
        
        // Extract messages and tool calls
        final firstMessages = TestHelpers.extractMessages(firstEvents);
        final toolCalls = TestHelpers.findToolCalls(firstMessages);
        
        expect(toolCalls, isNotEmpty, reason: 'Should have tool calls');

        // Create follow-up input with tool result acknowledgment
        final followUpInput = TestHelpers.createTestInput(
          messages: [
            ...firstMessages,
            UserMessage(
              id: 'msg-result',
              content: 'thanks',
            ),
          ],
        );

        // Run follow-up request
        final secondStream = agent.runAgent(
          'tool_based_generative_ui',
          followUpInput,
        );

        final secondEvents = await TestHelpers.collectEvents(secondStream);

        // Save combined transcript
        await TestHelpers.saveTranscript(
          [...firstEvents, ...secondEvents],
          'tool_roundtrip_transcript_${DateTime.now().millisecondsSinceEpoch}.jsonl',
        );

        // Validate second response
        TestHelpers.validateEventSequence(secondEvents);

        // Extract messages from second response
        final secondMessages = TestHelpers.extractMessages(secondEvents);
        
        // Should have acknowledgment message
        final assistantMessages = secondMessages.where(
          (m) => m.role == MessageRole.assistant,
        ).toList();

        expect(
          assistantMessages,
          isNotEmpty,
          reason: 'Should have assistant response to acknowledgment',
        );

        // Verify content indicates completion
        final responseContent = assistantMessages.first.content ?? '';
        expect(
          responseContent,
          equals('Haiku created'),
          reason: 'Should acknowledge haiku creation',
        );

        print('Tool round-trip test completed');
        print('First request events: ${firstEvents.length}');
        print('Second request events: ${secondEvents.length}');
      },
    );

    TestHelpers.runIntegrationTest(
      'should validate tool event ordering',
      () async {
        final input = TestHelpers.createTestInput(
          messages: [
            UserMessage(
              id: 'msg-1',
              content: 'Please generate a haiku',
            ),
          ],
        );

        final eventStream = agent.runAgent(
          'tool_based_generative_ui',
          input,
        );

        final events = await TestHelpers.collectEvents(eventStream);

        // Track event ordering
        bool foundRunStarted = false;
        bool foundToolCall = false;
        bool foundToolResult = false;
        bool foundMessagesWithTool = false;

        for (final event in events) {
          if (event.eventType == EventType.runStarted) {
            foundRunStarted = true;
            expect(
              foundToolCall,
              isFalse,
              reason: 'RUN_STARTED should come before tool calls',
            );
          } else if (event.eventType == EventType.toolCallStart ||
                     event.eventType == EventType.toolCallArgs ||
                     event.eventType == EventType.toolCallEnd) {
            foundToolCall = true;
            expect(
              foundRunStarted,
              isTrue,
              reason: 'Tool calls should come after RUN_STARTED',
            );
          } else if (event.eventType == EventType.toolCallResult) {
            foundToolResult = true;
            expect(
              foundToolCall,
              isTrue,
              reason: 'Tool results should come after tool calls',
            );
          } else if (event.eventType == EventType.messagesSnapshot ||
                     event.eventType == EventType.messagesSnapshot) {
            final List<Message> messages = event is MessagesSnapshotEvent 
                ? event.messages 
                : <Message>[];
            
            if (TestHelpers.findToolCalls(messages).isNotEmpty) {
              foundMessagesWithTool = true;
            }
          } else if (event.eventType == EventType.runFinished) {
            expect(
              foundRunStarted,
              isTrue,
              reason: 'RUN_FINISHED should come after RUN_STARTED',
            );
          }
        }

        expect(foundRunStarted, isTrue, reason: 'Should have RUN_STARTED');
        expect(foundToolCall, isTrue, reason: 'Should have TOOL_CALL events');
        expect(foundMessagesWithTool, isTrue, reason: 'Should have messages with tools');

        print('Tool event ordering test completed');
        print('Events validated: ${events.length}');
      },
    );
  });
}