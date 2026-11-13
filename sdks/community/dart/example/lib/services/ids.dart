/// Monotonic id generator. Uses a process-wide counter in addition to the timestamp
/// so two ids minted in the same microsecond never collide (important once ids are
/// used for dedup, e.g. reasoning messages).
int _counter = 0;

String uid(String prefix) =>
    '${prefix}_${DateTime.now().microsecondsSinceEpoch}_${_counter++}';
