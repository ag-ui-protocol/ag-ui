/// Compares two dotted numeric versions component by component; a missing
/// component counts as zero. Returns a negative number, zero or a positive
/// number as [a] is lower than, equal to or higher than [b].
int compareProtocolVersions(String a, String b) {
  final left = _components(a);
  final right = _components(b);
  final length = left.length > right.length ? left.length : right.length;
  for (var i = 0; i < length; i++) {
    final l = i < left.length ? left[i] : 0;
    final r = i < right.length ? right[i] : 0;
    if (l != r) return l.compareTo(r);
  }
  return 0;
}

List<int> _components(String version) => [
  for (final part in version.split('.')) int.tryParse(part) ?? 0,
];
