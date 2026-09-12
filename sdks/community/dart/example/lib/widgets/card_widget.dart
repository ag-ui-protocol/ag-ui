import 'package:flutter/material.dart';

/// Renders a `render_card` tool call (tool_based_generative_ui) as a UI card.
/// Expects `{title, subtitle?, facts?: [{label, value}], imageUrl?}`.
class CardWidget extends StatelessWidget {
  final Map<String, dynamic> data;

  const CardWidget({super.key, required this.data});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final title = data['title'] as String? ?? 'Card';
    final subtitle = data['subtitle'] as String?;
    final facts = (data['facts'] as List?) ?? const [];
    final imageUrl = data['imageUrl'] as String?;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Card(
        elevation: 2,
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (imageUrl != null && imageUrl.isNotEmpty)
              Image.network(
                imageUrl,
                height: 140,
                width: double.infinity,
                fit: BoxFit.cover,
                loadingBuilder: (context, child, progress) => progress == null
                    ? child
                    : Container(
                        height: 140,
                        alignment: Alignment.center,
                        color: theme.colorScheme.surfaceContainerHighest,
                        child: const CircularProgressIndicator(),
                      ),
                errorBuilder: (_, __, ___) => Container(
                  height: 140,
                  alignment: Alignment.center,
                  color: theme.colorScheme.surfaceContainerHighest,
                  child: Icon(Icons.broken_image_outlined,
                      color: theme.colorScheme.outline),
                ),
              ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: theme.textTheme.titleLarge),
                  if (subtitle != null && subtitle.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                  if (facts.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    for (final f in facts)
                      if (f is Map)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SizedBox(
                                width: 120,
                                child: Text(
                                  '${f['label'] ?? ''}',
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              Expanded(
                                child: Text('${f['value'] ?? ''}',
                                    style: theme.textTheme.bodyMedium),
                              ),
                            ],
                          ),
                        ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
