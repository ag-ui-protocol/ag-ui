import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:ag_ui/ag_ui.dart';
import '../models/endpoint_config.dart';
import '../models/seed_state.dart';
import '../services/ag_ui_service.dart';
import '../services/ids.dart';
import '../services/json_patch.dart';
import '../widgets/chat_input_widget.dart';
import '../widgets/checklist_widget.dart';
import '../widgets/recipe_card_widget.dart';
import '../widgets/predictive_steps_widget.dart';

/// Page for the live-state-projection features (`agentic_generative_ui`,
/// `shared_state`, `predictive_state_updates`): STATE_SNAPSHOT + RFC-6902 STATE_DELTA
/// stream applied to a local document that renders reactively.
class LiveStatePage extends StatelessWidget {
  final EndpointConfig endpoint;

  const LiveStatePage({super.key, required this.endpoint});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<LiveStatePageState>(
      create: (_) => LiveStatePageState(endpoint: endpoint),
      child: const LiveStatePageView(),
    );
  }
}

class LiveStatePageView extends StatelessWidget {
  const LiveStatePageView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = context.watch<LiveStatePageState>();

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
        bottom: state.busy
            ? const PreferredSize(
                preferredSize: Size.fromHeight(2),
                child: LinearProgressIndicator(),
              )
            : null,
      ),
      body: Column(
        children: [
          Expanded(child: _DocBody(state: state)),
          if (state.lastSummary != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: [
                  Icon(Icons.smart_toy,
                      size: 16, color: theme.colorScheme.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(state.lastSummary!,
                        style: theme.textTheme.bodySmall),
                  ),
                ],
              ),
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

class _DocBody extends StatelessWidget {
  final LiveStatePageState state;
  const _DocBody({required this.state});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doc = state.doc;

    if (doc == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(state.endpoint.icon, size: 64, color: theme.colorScheme.outline),
            const SizedBox(height: 16),
            Text(
              'Send a message to generate a plan…',
              style: theme.textTheme.titleMedium
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ],
        ),
      );
    }

    switch (state.endpoint.path) {
      case 'agentic_generative_ui':
        return ChecklistWidget(steps: (doc['steps'] as List?) ?? const []);
      case 'shared_state':
        return RecipeCardWidget(
          recipe: (doc['recipe'] as Map?)?.cast<String, dynamic>() ?? const {},
          onEditTitle: state.editTitle,
          onChangeServings: state.changeServings,
          onAddIngredient: state.addIngredient,
          onRemoveIngredient: state.removeIngredient,
        );
      case 'predictive_state_updates':
        final recipe =
            (doc['recipe'] as Map?)?.cast<String, dynamic>() ?? const {};
        final draft = (doc['_predictive'] as Map?)?['draft'] as String?;
        return PredictiveStepsWidget(
          steps: (recipe['steps'] as List?) ?? const [],
          draft: draft,
        );
      default:
        return const SizedBox.shrink();
    }
  }
}

class LiveStatePageState extends ChangeNotifier {
  final EndpointConfig endpoint;
  final AgUiService _service = AgUiService();
  final String _threadId = 'thread_${DateTime.now().millisecondsSinceEpoch}';
  final List<Message> _history = [];

  /// The live document (deep-mutable); null until the first STATE_SNAPSHOT, except
  /// the recipe routes which paint their seed immediately.
  dynamic doc;
  bool _busy = false;
  bool disposed = false;
  String? lastSummary;

  LiveStatePageState({required this.endpoint}) {
    final seed = seedStateFns[endpoint.path];
    if (seed != null) doc = seed();
  }

  bool get busy => _busy;

  void _notify() {
    if (!disposed) notifyListeners();
  }

  void sendMessage(String text) async {
    if (text.trim().isEmpty || _busy) return;

    _history.add(UserMessage(id: uid('user'), content: text.trim()));
    _busy = true;
    lastSummary = null;
    notifyListeners();

    try {
      await for (final event in _service.run(
        endpoint.path,
        threadId: _threadId,
        messages: _history,
        state: _stateForRequest(),
      )) {
        if (disposed) return;
        _handleEvent(event);
      }
    } catch (e) {
      if (!disposed) lastSummary = 'Error: $e';
    } finally {
      if (!disposed) {
        _busy = false;
        notifyListeners();
      }
    }
  }

  /// `agentic_generative_ui` owns its document; the recipe routes echo the (possibly
  /// user-edited) local document back so the server adopts it (last-writer-wins). The
  /// echo is cloned so an in-flight request never aliases the live, mutating doc.
  dynamic _stateForRequest() {
    if (endpoint.path == 'agentic_generative_ui' || doc == null) return null;
    return jsonDecode(jsonEncode(doc));
  }

  void _handleEvent(BaseEvent event) {
    // The document is the focus of these demos. The assistant's "what I changed"
    // summary is shown in the strip below; reasoning is intentionally not separately
    // surfaced here (the live document reaction is the feedback). RUN_ERROR is surfaced
    // in the summary strip so it is never silently swallowed.
    if (event is StateSnapshotEvent) {
      // snapshot is `dynamic` and could be null; clone when present, else reset.
      doc = event.snapshot == null ? null : jsonDecode(jsonEncode(event.snapshot));
    } else if (event is StateDeltaEvent) {
      doc = applyJsonPatch(doc, event.delta);
    } else if (event is TextMessageStartEvent) {
      lastSummary = '';
    } else if (event is TextMessageContentEvent) {
      lastSummary = (lastSummary ?? '') + event.delta;
    } else if (event is TextMessageChunkEvent) {
      lastSummary = (lastSummary ?? '') + (event.delta ?? '');
    } else if (event is RunErrorEvent) {
      lastSummary = '⚠️ Run error: ${event.message}';
      _busy = false;
    }
    _notify();
  }

  // --- Recipe card edits (shared_state collaboration) ---

  Map<String, dynamic>? get _recipe =>
      (doc?['recipe'] as Map?)?.cast<String, dynamic>();

  void editTitle(String title) {
    final r = _recipe;
    if (r == null) return;
    r['title'] = title;
    _notify();
  }

  void changeServings(int delta) {
    final r = _recipe;
    if (r == null) return;
    final current = ((r['servings'] as num?) ?? 0).toInt();
    r['servings'] = (current + delta).clamp(1, 99);
    _notify();
  }

  void addIngredient(String name, String amount) {
    final r = _recipe;
    if (r == null || name.trim().isEmpty) return;
    final list = (r['ingredients'] as List?) ?? (r['ingredients'] = []);
    list.add({'name': name.trim(), 'amount': amount.trim()});
    _notify();
  }

  void removeIngredient(int index) {
    final r = _recipe;
    final list = r?['ingredients'] as List?;
    if (list == null || index < 0 || index >= list.length) return;
    list.removeAt(index);
    _notify();
  }

  @override
  void dispose() {
    disposed = true;
    _service.dispose();
    super.dispose();
  }
}
