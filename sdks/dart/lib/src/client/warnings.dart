/// Where the client reports a deviation it tolerated: a stripped field, a
/// translated legacy shape, a producer declaring a newer protocol version.
/// The TypeScript client writes these to `console.warn`; here the caller
/// chooses, and the default is to say nothing.
typedef WarningSink = void Function(String message);

/// The default sink: warnings are dropped.
void ignoreWarnings(String message) {}
