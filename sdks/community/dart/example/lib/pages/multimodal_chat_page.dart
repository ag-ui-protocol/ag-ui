import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/endpoint_config.dart';
import '../services/ag_ui_service.dart';
import '../widgets/chat_message_widget.dart';
import '../widgets/multimodal_input_widget.dart';
import 'chat_page.dart';

class MultimodalChatPage extends StatelessWidget {
  final EndpointConfig endpoint;
  const MultimodalChatPage({Key? key, required this.endpoint}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<MultimodalChatPageState>(
      create: (_) => MultimodalChatPageState(endpoint: endpoint),
      child: const MultimodalChatPageView(),
    );
  }
}

class MultimodalChatPageView extends StatelessWidget {
  const MultimodalChatPageView({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final state = context.watch<MultimodalChatPageState>();
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.colorScheme.background,
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
          if (state.connectionStatus != ConnectionStatus.disconnected)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Icon(
                _connectionIcon(state.connectionStatus),
                color: _connectionColor(state.connectionStatus, theme),
                size: 20,
              ),
            ),
        ],
        bottom: state.isLoading
            ? PreferredSize(
                preferredSize: const Size.fromHeight(2),
                child: LinearProgressIndicator(
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation<Color>(theme.colorScheme.primary),
                ),
              )
            : null,
      ),
      body: Column(
        children: [
          Expanded(
            child: state.messages.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(state.endpoint.icon, size: 64,
                             color: theme.colorScheme.outline),
                        const SizedBox(height: 16),
                        Text('Attach a file to begin',
                             style: theme.textTheme.titleLarge?.copyWith(
                               color: theme.colorScheme.outline)),
                      ],
                    ),
                  )
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    itemCount: state.messages.length,
                    itemBuilder: (context, index) {
                      final reversedIndex = state.messages.length - 1 - index;
                      return ChatMessageWidget(message: state.messages[reversedIndex]);
                    },
                  ),
          ),
          MultimodalInputWidget(
            endpoint: state.endpoint,
            isEnabled: !state.isLoading,
            onPickFile: () => state.pickFile(state.endpoint.allowedExtensions, context),
            onSend: state.sendMultimodal,
            onClear: state.clearPicked,
          ),
        ],
      ),
    );
  }

  IconData _connectionIcon(ConnectionStatus s) => switch (s) {
        ConnectionStatus.connected    => Icons.check_circle,
        ConnectionStatus.connecting   => Icons.sync,
        ConnectionStatus.error        => Icons.error,
        ConnectionStatus.disconnected => Icons.circle_outlined,
      };

  Color _connectionColor(ConnectionStatus s, ThemeData theme) => switch (s) {
        ConnectionStatus.connected    => Colors.green,
        ConnectionStatus.connecting   => theme.colorScheme.primary,
        ConnectionStatus.error        => theme.colorScheme.error,
        ConnectionStatus.disconnected => theme.colorScheme.outline,
      };
}
