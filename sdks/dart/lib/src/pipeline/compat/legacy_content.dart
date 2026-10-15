import '../../client/warnings.dart';

/// Whether [part] is a retired `binary` content part with a mime type.
bool isLegacyBinaryContent(Object? part) =>
    part is Map && part['type'] == 'binary' && part['mimeType'] is String;

String _contentTypeFor(String mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/// Converts a legacy binary part to its modern media part. A part carrying
/// only an id cannot be converted; it is returned unchanged, with a warning,
/// so losing it downstream is not silent.
Map<String, Object?> convertBinaryToNewFormat(
  Map<String, Object?> binary,
  WarningSink warn,
) {
  final mimeType = binary['mimeType'] as String;
  final contentType = _contentTypeFor(mimeType);
  final filename = binary['filename'];
  final data = binary['data'];
  final url = binary['url'];
  Map<String, Object?> modern(String sourceType, Object value) => {
    'type': contentType,
    'source': {'type': sourceType, 'value': value, 'mimeType': mimeType},
    if (filename is String && filename.isNotEmpty)
      'metadata': {'filename': filename},
  };
  if (data is String && data.isNotEmpty) return modern('data', data);
  if (url is String && url.isNotEmpty) return modern('url', url);
  warn(
    '[ag-ui][compat] A binary content part carries only an id '
    "('${binary['id'] ?? ''}') and cannot be converted to a modern media "
    'part; a 1.0 peer will not accept it. Provide data or a url. See the '
    'repo-root DEPRECATIONS.md.',
  );
  return binary;
}

bool _matchesModernPart(
  Object? part,
  Map<String, Object?> converted,
  Object? filename,
) {
  if (part is! Map || part['type'] != converted['type']) return false;
  final source = part['source'];
  final expected = converted['source'] as Map<String, Object?>;
  if (source is! Map ||
      source['type'] != expected['type'] ||
      source['value'] != expected['value'] ||
      source['mimeType'] != expected['mimeType']) {
    return false;
  }
  if (filename is! String || filename.isEmpty) return true;
  final metadata = part['metadata'];
  return metadata is Map && metadata['filename'] == filename;
}

/// Upgrades every legacy binary part in a raw message's content to the
/// modern media part, dropping a legacy part that mirrors a modern part
/// already present. Returns the message unchanged when its content is not a
/// list.
Map<String, Object?> upgradeMessageContent(
  Map<String, Object?> message,
  WarningSink warn,
) {
  final content = message['content'];
  if (content is! List) return message;
  final upgraded = <Object?>[];
  for (final part in content) {
    if (!isLegacyBinaryContent(part)) {
      upgraded.add(part);
      continue;
    }
    final legacy = (part as Map).cast<String, Object?>();
    final converted = convertBinaryToNewFormat(legacy, warn);
    if (converted['type'] != 'binary' &&
        content.any(
          (other) => _matchesModernPart(other, converted, legacy['filename']),
        )) {
      continue;
    }
    upgraded.add(converted);
  }
  return Map<String, Object?>.from(message)..['content'] = upgraded;
}
