import 'package:flutter/material.dart';

/// Renders `predictive_state_updates`: committed recipe steps at full opacity, plus a
/// ghosted "drafting…" overlay driven by the ephemeral `/_predictive` namespace. When
/// the prediction commits to `/recipe/steps` and `/_predictive` is removed, the ghost
/// clears.
class PredictiveStepsWidget extends StatelessWidget {
  final List steps;
  final String? draft;

  const PredictiveStepsWidget({super.key, required this.steps, this.draft});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Recipe steps', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        for (int i = 0; i < steps.length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Text('${i + 1}. ${steps[i]}'),
          ),
        if (draft != null && draft!.trim().isNotEmpty) ...[
          const SizedBox(height: 16),
          Row(
            children: [
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: theme.colorScheme.outline,
                ),
              ),
              const SizedBox(width: 8),
              Text('drafting…',
                  style: theme.textTheme.labelMedium
                      ?.copyWith(color: theme.colorScheme.outline)),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            draft!,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontStyle: FontStyle.italic,
              color: theme.colorScheme.outline,
            ),
          ),
        ],
      ],
    );
  }
}
