import 'package:flutter/material.dart';

/// The human-in-the-loop approval gate: shows the proposed consequential action and
/// Approve / Deny buttons. Rendered as a panel above the input while a decision is
/// pending; the user's choice becomes the tool result.
class ApprovalCardWidget extends StatelessWidget {
  final String summary;
  final VoidCallback onApprove;
  final VoidCallback onDeny;

  const ApprovalCardWidget({
    super.key,
    required this.summary,
    required this.onApprove,
    required this.onDeny,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.error.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.warning_amber_rounded, color: theme.colorScheme.error),
              const SizedBox(width: 8),
              Text('Approval required',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 8),
          Text(summary, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(onPressed: onDeny, child: const Text('Deny')),
              const SizedBox(width: 8),
              FilledButton(onPressed: onApprove, child: const Text('Approve')),
            ],
          ),
        ],
      ),
    );
  }
}
