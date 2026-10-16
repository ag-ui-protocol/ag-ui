import 'package:flutter/material.dart';

/// Renders the `shared_state` recipe document as an editable card. Agent edits arrive
/// via STATE_DELTA and update reactively; user edits mutate the local doc and are echoed
/// back on the next send (last-writer-wins).
class RecipeCardWidget extends StatelessWidget {
  final Map<String, dynamic> recipe;
  final ValueChanged<String> onEditTitle;
  final ValueChanged<int> onChangeServings;
  final void Function(String name, String amount) onAddIngredient;
  final ValueChanged<int> onRemoveIngredient;

  const RecipeCardWidget({
    super.key,
    required this.recipe,
    required this.onEditTitle,
    required this.onChangeServings,
    required this.onAddIngredient,
    required this.onRemoveIngredient,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final title = recipe['title'] as String? ?? 'Recipe';
    final servings = ((recipe['servings'] as num?) ?? 0).toInt();
    final ingredients = (recipe['ingredients'] as List?) ?? const [];
    final steps = (recipe['steps'] as List?) ?? const [];

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Title (editable). NOTE: `initialValue` + a title-keyed ValueKey makes
                // the field reflect agent STATE_DELTA title edits, at the cost of
                // rebuilding (losing focus / in-progress text) if the agent edits the
                // title while the user is typing. Acceptable for the demo; switch to a
                // controller + didUpdateWidget reconciliation if smoother concurrent
                // editing is needed.
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        key: ValueKey('title_$title'),
                        initialValue: title,
                        style: theme.textTheme.titleLarge,
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          isDense: true,
                        ),
                        onFieldSubmitted: onEditTitle,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                // Servings stepper.
                Row(
                  children: [
                    Text('Servings', style: theme.textTheme.labelLarge),
                    const SizedBox(width: 12),
                    IconButton(
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed: () => onChangeServings(-1),
                    ),
                    Text('$servings', style: theme.textTheme.titleMedium),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: () => onChangeServings(1),
                    ),
                  ],
                ),
                const Divider(),
                Text('Ingredients', style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                for (int i = 0; i < ingredients.length; i++)
                  _IngredientRow(
                    ingredient: ingredients[i],
                    onRemove: () => onRemoveIngredient(i),
                  ),
                _AddIngredientRow(onAdd: onAddIngredient),
                const Divider(),
                Text('Steps', style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                for (int i = 0; i < steps.length; i++)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Text('${i + 1}. ${steps[i]}'),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _IngredientRow extends StatelessWidget {
  final dynamic ingredient;
  final VoidCallback onRemove;

  const _IngredientRow({required this.ingredient, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final name = ingredient is Map ? '${ingredient['name'] ?? ''}' : '$ingredient';
    final amount = ingredient is Map ? '${ingredient['amount'] ?? ''}' : '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          const Text('• '),
          Expanded(
            child: Text(amount.isEmpty ? name : '$amount  $name'),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 18),
            onPressed: onRemove,
            tooltip: 'Remove',
          ),
        ],
      ),
    );
  }
}

class _AddIngredientRow extends StatefulWidget {
  final void Function(String name, String amount) onAdd;
  const _AddIngredientRow({required this.onAdd});

  @override
  State<_AddIngredientRow> createState() => _AddIngredientRowState();
}

class _AddIngredientRowState extends State<_AddIngredientRow> {
  final _name = TextEditingController();
  final _amount = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    super.dispose();
  }

  void _submit() {
    if (_name.text.trim().isEmpty) return;
    widget.onAdd(_name.text, _amount.text);
    _name.clear();
    _amount.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          SizedBox(
            width: 70,
            child: TextField(
              controller: _amount,
              decoration: const InputDecoration(
                hintText: 'amt',
                isDense: true,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _name,
              decoration: const InputDecoration(
                hintText: 'add ingredient…',
                isDense: true,
              ),
              onSubmitted: (_) => _submit(),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: _submit,
            tooltip: 'Add',
          ),
        ],
      ),
    );
  }
}
