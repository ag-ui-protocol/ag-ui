import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/endpoint_config.dart';
import '../pages/chat_page.dart';

class MultimodalInputWidget extends StatefulWidget {
  final EndpointConfig endpoint;
  final bool isEnabled;
  final VoidCallback onPickFile;
  final void Function(String question) onSend;
  final VoidCallback onClear;

  const MultimodalInputWidget({
    Key? key,
    required this.endpoint,
    required this.isEnabled,
    required this.onPickFile,
    required this.onSend,
    required this.onClear,
  }) : super(key: key);

  @override
  State<MultimodalInputWidget> createState() => _MultimodalInputWidgetState();
}

class _MultimodalInputWidgetState extends State<MultimodalInputWidget> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<MultimodalChatPageState>();
    final isAudio = widget.endpoint.path == 'audio';

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (state.hasFile)
            _FilePreview(
              endpoint: widget.endpoint,
              bytes: state.pickedBytes,
              fileName: state.pickedFileName ?? '',
              onClear: widget.isEnabled ? widget.onClear : null,
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
            child: Row(
              children: [
                IconButton(
                  icon: const Icon(Icons.attach_file),
                  onPressed: widget.isEnabled ? widget.onPickFile : null,
                  tooltip: 'Attach file',
                ),
                if (!isAudio)
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      decoration: InputDecoration(
                        hintText: widget.endpoint.path == 'document'
                            ? 'Ask a question about the document...'
                            : 'Describe what you want to know...',
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(24),
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16, vertical: 8),
                      ),
                      enabled: widget.isEnabled,
                      onSubmitted: state.hasFile && widget.isEnabled
                          ? (_) {
                              widget.onSend(_controller.text);
                              _controller.clear();
                            }
                          : null,
                    ),
                  )
                else
                  const Expanded(
                    child: Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8),
                      child: Text(
                        'Pick an audio file and tap Send to transcribe.',
                        style: TextStyle(color: Colors.grey),
                      ),
                    ),
                  ),
                IconButton(
                  icon: const Icon(Icons.send),
                  onPressed: state.hasFile && widget.isEnabled
                      ? () {
                          widget.onSend(_controller.text);
                          _controller.clear();
                        }
                      : null,
                  tooltip: 'Send',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FilePreview extends StatelessWidget {
  final EndpointConfig endpoint;
  final Uint8List? bytes;
  final String fileName;
  final VoidCallback? onClear;

  const _FilePreview({
    required this.endpoint,
    required this.bytes,
    required this.fileName,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 4, 8, 0),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceVariant,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          if (endpoint.path == 'vision' && bytes != null)
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: Image.memory(bytes!, height: 60, fit: BoxFit.cover),
            )
          else
            Icon(
              endpoint.path == 'audio'
                  ? Icons.audio_file
                  : Icons.picture_as_pdf,
              size: 36,
              color: theme.colorScheme.primary,
            ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              fileName,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 18),
            onPressed: onClear,
            tooltip: 'Remove',
          ),
        ],
      ),
    );
  }
}
