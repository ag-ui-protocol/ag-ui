import 'package:flutter/material.dart';

class ChatInputWidget extends StatefulWidget {
  final Function(String) onSendMessage;
  final bool isEnabled;

  const ChatInputWidget({
    Key? key,
    required this.onSendMessage,
    this.isEnabled = true,
  }) : super(key: key);

  @override
  State<ChatInputWidget> createState() => _ChatInputWidgetState();
}

class _ChatInputWidgetState extends State<ChatInputWidget> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  void _handleSubmit() {
    final text = _controller.text.trim();
    if (text.isNotEmpty && widget.isEnabled) {
      widget.onSendMessage(text);
      _controller.clear();
      _focusNode.requestFocus();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(
            color: theme.colorScheme.outlineVariant,
            width: 1,
          ),
        ),
      ),
      child: SafeArea(
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                focusNode: _focusNode,
                enabled: widget.isEnabled,
                maxLines: null,
                keyboardType: TextInputType.multiline,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _handleSubmit(),
                decoration: InputDecoration(
                  hintText: widget.isEnabled
                      ? 'Type a message...'
                      : 'Waiting for response...',
                  filled: true,
                  fillColor: theme.colorScheme.surfaceVariant,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide(
                      color: theme.colorScheme.primary,
                      width: 2,
                    ),
                  ),
                  disabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(24),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Material(
              color: widget.isEnabled
                  ? theme.colorScheme.primary
                  : theme.colorScheme.surfaceVariant,
              borderRadius: BorderRadius.circular(24),
              child: InkWell(
                onTap: widget.isEnabled ? _handleSubmit : null,
                borderRadius: BorderRadius.circular(24),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Icon(
                    Icons.send,
                    color: widget.isEnabled
                        ? theme.colorScheme.onPrimary
                        : theme.colorScheme.outline,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}