import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:ag_ui/ag_ui.dart';
import '../models/chat_message.dart';
import '../models/endpoint_config.dart';
import '../services/ag_ui_service.dart';
import '../services/ids.dart';
import '../widgets/chat_message_widget.dart';
import '../widgets/chat_input_widget.dart';
import '../widgets/card_widget.dart';
import '../widgets/approval_card_widget.dart';
import 'agui_event_handling.dart';

/// Page for the client-tool round-trip features:
///  - `agentic_chat` (FeatureKind.clientTools) — model calls a tool, client executes,
///    result returns inline.
///  - `tool_based_generative_ui` (FeatureKind.clientTools) — model calls `render_card`,
///    the call is rendered AS a UI card.
///  - `human_in_the_loop` (FeatureKind.approval) — the tool call is gated by an
///    approve/deny decision; the decision becomes the tool result.
class ClientToolsPage extends StatelessWidget {
  final EndpointConfig endpoint;

  const ClientToolsPage({super.key, required this.endpoint});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<ClientToolsPageState>(
      create: (_) => ClientToolsPageState(endpoint: endpoint),
      child: const ClientToolsPageView(),
    );
  }
}

class ClientToolsPageView extends StatelessWidget {
  const ClientToolsPageView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = context.watch<ClientToolsPageState>();

    return Scaffold(
      backgroundColor: theme.colorScheme.surface,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(state.endpoint.name, style: theme.textTheme.titleMedium),
            Text(
              state.endpoint.description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        actions: [
          if (state.isApproval)
            Row(
              children: [
                const Text('Gate', style: TextStyle(fontSize: 12)),
                Switch(
                  value: state.approvalGate,
                  onChanged: state.busy ? null : state.setApprovalGate,
                ),
              ],
            ),
        ],
        bottom: state.busy
            ? const PreferredSize(
                preferredSize: Size.fromHeight(2),
                child: LinearProgressIndicator(),
              )
            : null,
      ),
      body: Column(
        children: [
          Expanded(
            child: state.messages.isEmpty
                ? _EmptyState(endpoint: state.endpoint)
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    itemCount: state.messages.length,
                    itemBuilder: (context, index) {
                      final msg = state.messages[state.messages.length - 1 - index];
                      if (msg.type == ChatMessageType.card &&
                          msg.cardData != null) {
                        return CardWidget(data: msg.cardData!);
                      }
                      return ChatMessageWidget(message: msg);
                    },
                  ),
          ),
          if (state.pendingApproval != null)
            ApprovalCardWidget(
              summary: state.pendingApproval!,
              onApprove: state.approve,
              onDeny: state.deny,
            ),
          ChatInputWidget(
            onSendMessage: state.sendMessage,
            isEnabled: !state.busy,
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final EndpointConfig endpoint;
  const _EmptyState({required this.endpoint});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(endpoint.icon, size: 64, color: theme.colorScheme.outline),
          const SizedBox(height: 16),
          Text(
            endpoint.featureKind == FeatureKind.approval
                ? 'Ask the agent to do something consequential'
                : endpoint.tools.isEmpty
                    ? 'Start a conversation with the agent'
                    : 'Ask the agent something it can use a tool for',
            style: theme.textTheme.titleMedium
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        ],
      ),
    );
  }
}

class ClientToolsPageState extends ChangeNotifier with AgUiEventHandling {
  final EndpointConfig endpoint;
  final AgUiService _service;
  final String _threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';

  /// Conversation history sent on every run, replaced by full snapshots.
  final List<Message> _history = [];
  Set<String> _priorRunMessageIds = const {};
  final Set<String> _snapshotCoveredMessageIds = {};

  List<ToolCall> _pendingCalls = const [];
  AssistantMessage? _pendingAssistant;
  List<ToolMessage> _pendingResults = const [];
  // A continuation snapshot is staged until that run emits RUN_FINISHED.
  bool _runCompleted = false;

  /// Reasoning message ids already rendered, so a cumulative MESSAGES_SNAPSHOT
  /// (the full history each round) doesn't re-append earlier reasoning blocks.
  final Set<String> _seenReasoningIds = {};

  /// Loading flag spanning the whole exchange (first send → last re-run).
  bool _busy = false;

  /// True only while [_resolveToolCalls] is running — the launch re-entrancy guard and
  /// the signal that the initial-send loop (and [onRunReset]) must NOT clear [_busy].
  bool _resolving = false;

  /// Set when a run errors (RUN_ERROR via the stream). The resolve loop checks it after
  /// each event so it stops consuming a post-error stream instead of looping again.
  bool _aborted = false;

  // Approval (human_in_the_loop) state.
  bool _approvalGate = true; // gate on by default
  String? _pendingApproval; // human-readable summary; non-null while awaiting decision
  Completer<bool>? _approvalCompleter;

  /// [service] is injectable for tests; production constructs the default.
  ClientToolsPageState({required this.endpoint, AgUiService? service})
      : _service = service ?? AgUiService();

  bool get busy => _busy;
  bool get isApproval => endpoint.featureKind == FeatureKind.approval;
  bool get approvalGate => _approvalGate;
  String? get pendingApproval => _pendingApproval;

  void _notify() {
    if (!disposed) notifyListeners();
  }

  void setApprovalGate(bool v) {
    _approvalGate = v;
    _notify();
  }

  @override
  void onRunReset() {
    // Called by the mixin on RUN_ERROR. Mark aborted and clear pending work, but do NOT
    // touch _busy/_resolving while a resolve loop owns them — its finally tears down.
    _aborted = true;
    _runCompleted = false;
    _pendingCalls = const [];
    _pendingAssistant = null;
    _pendingResults = const [];
    if (!_resolving) _busy = false;
  }

  void sendMessage(String text) async {
    if (disposed || text.trim().isEmpty || _busy) return;

    // A new turn: drop any pending calls left stale by a prior stream that closed
    // without RUN_FINISHED (network drop), so they can't replay against this turn.
    _pendingCalls = const [];
    _pendingAssistant = null;
    _pendingResults = const [];
    _aborted = false;

    final id = uid('user');
    _history.add(UserMessage(id: id, content: text.trim()));
    messages.add(ChatMessage(
      id: id,
      type: ChatMessageType.user,
      content: text.trim(),
      timestamp: DateTime.now(),
    ));
    _busy = true;
    _notify();

    try {
      await for (final event in _run()) {
        if (disposed || _aborted) return;
        _handleEvent(event);
      }
    } catch (e) {
      if (!disposed) _addError(e);
    } finally {
      // Clear _busy only if no round-trip is in flight (a launched _resolveToolCalls
      // owns the flag and clears it when the exchange converges).
      if (!disposed && !_resolving) {
        _busy = false;
        _notify();
      }
    }
  }

  Stream<BaseEvent> _run() {
    _runCompleted = false;
    _priorRunMessageIds = messages.map((message) => message.id).toSet();
    _snapshotCoveredMessageIds.clear();
    // Reset the display-only stream between requests, including an interrupted
    // stream. Otherwise the next chunk-only reply could append to its fragment.
    final streaming = messages
        .where((m) => m.type == ChatMessageType.assistant && m.isStreaming)
        .lastOrNull;
    if (streaming != null) {
      handleCommonEvent(TextMessageEndEvent(messageId: streaming.id));
    }
    return _service.run(
      endpoint.path,
      threadId: _threadId,
      messages: _history,
      tools: endpoint.tools,
      extraQuery: isApproval && !_approvalGate ? {'approval': 'off'} : const {},
    );
  }

  void _handleEvent(BaseEvent event) {
    if (handleCommonEvent(event)) {
      if (event is TextMessageEndEvent) {
        _rememberCompletedReplies(messageId: event.messageId);
      }
      _notify();
      return;
    }

    if (event is MessagesSnapshotEvent) {
      // MESSAGES_SNAPSHOT is the entire authoritative conversation, not a
      // batch of additions. The Go backend regenerates every message ID, so
      // merging by ID duplicates replies and creates unanswered tool proposals.
      _snapshotCoveredMessageIds.addAll(messages.map((message) => message.id));
      final resolvedCalls = event.messages
          .whereType<ToolMessage>()
          .map((message) => message.toolCallId)
          .toSet();
      final assistant = event.messages.whereType<AssistantMessage>().lastOrNull;
      _pendingCalls = (assistant?.toolCalls ?? const <ToolCall>[])
          .where((call) => !resolvedCalls.contains(call.id))
          .toList();
      _pendingAssistant = _pendingCalls.isEmpty ? null : assistant;
      final stagedCallIds = _pendingAssistant?.toolCalls
              ?.map((call) => call.id)
              .toSet() ??
          const <String>{};
      _pendingResults = event.messages
          .whereType<ToolMessage>()
          .where((message) => stagedCallIds.contains(message.toolCallId))
          .toList();
      // Stage a pending proposal together with any results the server already
      // supplied. An interrupted run must not leave an unanswered call (or an
      // orphaned result) in the next user turn. The resolve loop appends this
      // exchange in order only after RUN_FINISHED.
      _history
        ..clear()
        ..addAll(event.messages.where((message) =>
            !identical(message, _pendingAssistant) &&
            !(message is ToolMessage &&
                stagedCallIds.contains(message.toolCallId))));
      // Reasoning messages: a snapshot is the FULL history, so dedup by id or each
      // round would re-render earlier reasoning blocks.
      for (final m in event.messages.whereType<ReasoningMessage>()) {
        final rid = m.id;
        if (rid != null && !_seenReasoningIds.add(rid)) continue;
        addReasoningMessage(m.content ?? '');
      }
    } else if (event is RunFinishedEvent) {
      _runCompleted = true;
      // Chunk-only peers may omit TEXT_MESSAGE_END. A successful run completes
      // only this run's replies, never fragments from an earlier interrupted run.
      _rememberCompletedReplies();
      if (!_resolving && _pendingCalls.isNotEmpty) {
        // Launch the round-trip ONCE; the while-loop inside drives subsequent rounds.
        _resolveToolCalls();
      } else {
        // Tripwire: if a future server streamed TOOL_CALL_* without a terminating
        // MESSAGES_SNAPSHOT, _pendingCalls would be empty here and the round-trip would
        // silently no-op. Today's server always emits the snapshot first.
        assert(() {
          // No-op in release; documents the invariant in debug.
          return true;
        }());
      }
    }

    _notify();
  }

  void _rememberCompletedReplies({String? messageId}) {
    for (final reply in messages) {
      if (reply.type != ChatMessageType.assistant ||
          _priorRunMessageIds.contains(reply.id) ||
          _snapshotCoveredMessageIds.contains(reply.id) ||
          (messageId != null && reply.id != messageId)) {
        continue;
      }
      // A snapshot is authoritative, and a reply already completed by END must
      // not be appended again at RUN_FINISHED or lose its tool-call metadata.
      if (_history.any((message) => message.id == reply.id)) continue;
      _history.add(AssistantMessage(id: reply.id, content: reply.content));
    }
  }

  Future<void> _resolveToolCalls() async {
    _resolving = true;
    try {
      while (!_aborted && !disposed && _runCompleted && _pendingCalls.isNotEmpty) {
        // The assistant message that requested the calls must precede the tool
        // results in history (the model provider enforces this ordering, not the
        // Go server).
        _history.add(_pendingAssistant!);
        _history.addAll(_pendingResults);
        final calls = _pendingCalls;
        _pendingCalls = const [];
        _pendingAssistant = null;
        _pendingResults = const [];

        for (final call in calls) {
          final result = await _execute(call); // may await a user decision (approval)
          if (disposed || _aborted) return; // stop processing remaining calls
          _history.add(ToolMessage(
            id: uid('tool'),
            toolCallId: call.id,
            content: result,
          ));
        }

        if (disposed || _aborted) return;

        // Re-run with the full history. _handleEvent may repopulate _pendingCalls
        // (another tool round) → the while-loop continues.
        await for (final event in _run()) {
          if (disposed || _aborted) return; // stop consuming a post-error stream
          _handleEvent(event);
        }
      }
    } catch (e) {
      if (!disposed) _addError(e);
    } finally {
      _resolving = false;
      // This loop owns _busy once launched; on exit the exchange is converged,
      // aborted, or disposed.
      if (!disposed) {
        _busy = false;
        _notify();
      }
    }
  }

  /// Execute one tool call and return the JSON result string the model will read.
  Future<String> _execute(ToolCall call) async {
    final name = call.function.name;
    final args = _parseArgs(call.function.arguments);

    if (isApproval && _approvalGate) {
      return _executeWithApproval(name, args);
    }

    switch (name) {
      case 'get_current_time':
        final r = jsonEncode({'time': DateTime.now().toIso8601String()});
        _addToolBubble(name, args, r);
        return r;
      case 'calculate':
        final r = _calculate(args['expression'] as String? ?? '');
        _addToolBubble(name, args, r);
        return r;
      case 'render_card':
        // The card IS the result: render it, then acknowledge so the model can close.
        messages.add(ChatMessage(
          id: uid('card'),
          type: ChatMessageType.card,
          content: args['title'] as String? ?? 'Card',
          timestamp: DateTime.now(),
          cardData: args,
        ));
        _notify();
        return jsonEncode({'rendered': true});
      default:
        // Ungated approval route (gate off) or unknown tool: perform the demo action.
        if (isApproval) {
          return jsonEncode({'result': _performDemoAction(name, args)});
        }
        return jsonEncode({'error': 'unknown tool $name'});
    }
  }

  Future<String> _executeWithApproval(
      String name, Map<String, dynamic> args) async {
    // Guard the whole flow against disposal so a multi-approval batch can't hang or
    // notify after dispose. dispose() completes any in-flight completer with false.
    if (disposed) return jsonEncode({'approved': false, 'reason': 'cancelled'});
    _pendingApproval = _summarize(name, args);
    _approvalCompleter = Completer<bool>();
    _notify();

    final approved = await _approvalCompleter!.future;
    _pendingApproval = null;
    _approvalCompleter = null;
    if (disposed) return jsonEncode({'approved': false, 'reason': 'cancelled'});

    messages.add(ChatMessage(
      id: uid('decision'),
      type: ChatMessageType.system,
      content: approved ? '✅ Approved: $name' : '🚫 Denied: $name',
      timestamp: DateTime.now(),
    ));
    _notify();

    if (!approved) {
      return jsonEncode(
          {'approved': false, 'reason': 'The user declined this action.'});
    }
    return jsonEncode({'approved': true, 'result': _performDemoAction(name, args)});
  }

  /// Renders an agentic_chat tool call + its result as a visible bubble, so the
  /// invocation is shown (plan 02), not just the model's final text.
  void _addToolBubble(String name, Map<String, dynamic> args, String result) {
    messages.add(ChatMessage(
      id: uid('tool'),
      type: ChatMessageType.tool,
      content: args.isEmpty
          ? '$name()\n→ $result'
          : '$name(${jsonEncode(args)})\n→ $result',
      timestamp: DateTime.now(),
      toolName: name,
    ));
    _notify();
  }

  // approve()/deny() are only valid while [pendingApproval] != null — the approval
  // panel (the only caller) is shown exactly then, so UI gating is the guard. Both
  // no-op safely if no completer is pending.
  void approve() => _resolveDecision(true);
  void deny() => _resolveDecision(false);

  void _resolveDecision(bool v) {
    final c = _approvalCompleter;
    if (c != null && !c.isCompleted) c.complete(v);
  }

  String _summarize(String name, Map<String, dynamic> args) {
    switch (name) {
      case 'request_approval':
        return (args['summary'] as String?)?.trim().isNotEmpty == true
            ? args['summary'] as String
            : 'Approve action: ${args['action'] ?? name}?';
      default:
        return 'Run $name with ${jsonEncode(args)}';
    }
  }

  String _performDemoAction(String name, Map<String, dynamic> args) {
    switch (name) {
      case 'request_approval':
        return 'The user approved. You may proceed with: ${args['action'] ?? 'the action'}.';
      default:
        return 'Done.';
    }
  }

  /// Tiny arithmetic evaluator for the `calculate` demo tool. Returns a JSON result;
  /// never throws (errors become `{"error": ...}` so the model can recover).
  String _calculate(String expr) {
    try {
      final value = _evalExpression(expr);
      return jsonEncode({'result': value});
    } catch (e) {
      return jsonEncode({'error': 'could not evaluate "$expr"'});
    }
  }

  Map<String, dynamic> _parseArgs(String raw) {
    if (raw.trim().isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(raw);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  void _addError(Object e) {
    messages.add(ChatMessage(
      id: uid('error'),
      type: ChatMessageType.system,
      content: 'Error: $e',
      timestamp: DateTime.now(),
    ));
    _notify();
  }

  @override
  void dispose() {
    disposed = true;
    // Unwind any awaiting approval so _resolveToolCalls doesn't leak.
    if (_approvalCompleter != null && !_approvalCompleter!.isCompleted) {
      _approvalCompleter!.complete(false);
    }
    _service.dispose();
    super.dispose();
  }
}

/// Shunting-yard evaluator for +, -, *, /, parentheses over doubles.
num _evalExpression(String input) {
  final tokens = _tokenize(input);
  final output = <Object>[]; // numbers (num) and operators (String)
  final ops = <String>[];
  const prec = {'+': 1, '-': 1, '*': 2, '/': 2};

  for (final t in tokens) {
    if (t is num) {
      output.add(t);
    } else if (t == '(') {
      ops.add(t as String);
    } else if (t == ')') {
      while (ops.isNotEmpty && ops.last != '(') {
        output.add(ops.removeLast());
      }
      if (ops.isEmpty) throw const FormatException('mismatched parens');
      ops.removeLast();
    } else {
      while (ops.isNotEmpty &&
          ops.last != '(' &&
          prec[ops.last]! >= prec[t as String]!) {
        output.add(ops.removeLast());
      }
      ops.add(t as String);
    }
  }
  while (ops.isNotEmpty) {
    final op = ops.removeLast();
    if (op == '(') throw const FormatException('mismatched parens');
    output.add(op);
  }

  final stack = <num>[];
  for (final tok in output) {
    if (tok is num) {
      stack.add(tok);
    } else {
      if (stack.length < 2) throw const FormatException('bad expression');
      final b = stack.removeLast();
      final a = stack.removeLast();
      switch (tok as String) {
        case '+':
          stack.add(a + b);
        case '-':
          stack.add(a - b);
        case '*':
          stack.add(a * b);
        case '/':
          if (b == 0) throw const FormatException('divide by zero');
          stack.add(a / b);
      }
    }
  }
  if (stack.length != 1) throw const FormatException('bad expression');
  return stack.single;
}

final _numChar = RegExp(r'[0-9.]');

List<Object> _tokenize(String input) {
  final tokens = <Object>[];
  final s = input.replaceAll(' ', '');
  int i = 0;
  // True where a value is expected: at the start, after an operator, or after '('.
  // A '-' in that position is a unary minus on the following numeric literal.
  bool expectValue = true;
  while (i < s.length) {
    final c = s[i];
    if (c == '-' &&
        expectValue &&
        i + 1 < s.length &&
        _numChar.hasMatch(s[i + 1])) {
      final start = i;
      i++; // consume '-'
      while (i < s.length && _numChar.hasMatch(s[i])) {
        i++;
      }
      tokens.add(num.parse(s.substring(start, i))); // negative literal
      expectValue = false;
    } else if ('+-*/()'.contains(c)) {
      tokens.add(c);
      i++;
      expectValue = c != ')'; // after ')' a value is not expected; after op/'(' it is
    } else {
      final start = i;
      while (i < s.length && _numChar.hasMatch(s[i])) {
        i++;
      }
      if (i == start) throw FormatException('unexpected char "$c"');
      tokens.add(num.parse(s.substring(start, i)));
      expectValue = false;
    }
  }
  return tokens;
}
