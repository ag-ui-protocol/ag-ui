import 'package:flutter/material.dart';

/// Renders `agentic_generative_ui` steps as an animated checklist. Rows flip
/// pending → in_progress → completed as paced STATE_DELTAs arrive.
class ChecklistWidget extends StatelessWidget {
  final List steps;

  const ChecklistWidget({super.key, required this.steps});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: steps.length,
      itemBuilder: (context, i) {
        final step = steps[i];
        final description =
            step is Map ? '${step['description'] ?? 'Step ${i + 1}'}' : '$step';
        final status = step is Map ? '${step['status'] ?? 'pending'}' : 'pending';
        return ListTile(
          leading: _statusIcon(status, theme),
          title: Text(
            description,
            style: TextStyle(
              color: status == 'completed'
                  ? theme.colorScheme.onSurfaceVariant
                  : theme.colorScheme.onSurface,
              decoration:
                  status == 'completed' ? TextDecoration.lineThrough : null,
            ),
          ),
        );
      },
    );
  }

  Widget _statusIcon(String status, ThemeData theme) {
    switch (status) {
      case 'completed':
        return Icon(Icons.check_circle, color: Colors.green);
      case 'in_progress':
        return const SizedBox(
          width: 24,
          height: 24,
          child: Padding(
            padding: EdgeInsets.all(2),
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        );
      default:
        return Icon(Icons.radio_button_unchecked,
            color: theme.colorScheme.outline);
    }
  }
}
