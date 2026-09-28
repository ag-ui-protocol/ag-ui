using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;

namespace AGUI.Abstractions;

/// <summary>
/// Represents string-or-parts message content: what an <see cref="AGUIUserMessage"/> sends
/// and what an <see cref="AGUIToolMessage"/> (or the <see cref="ToolCallResultEvent"/> that
/// mints one) returns. The spec models it as a union of a plain string or a list of
/// <see cref="AGUIInputContent"/> parts (<c>content: string | ContentPart[]</c>).
/// </summary>
/// <remarks>
/// This is a hand-rolled union following the C# 15 "basic union pattern": it is marked with
/// <c>[Union]</c> and exposes a public <see cref="Value"/> plus one single-parameter
/// constructor per case type. Under a C# 15+ compiler the same type is recognized as a real
/// union (gaining union conversions, pattern-match unwrapping and exhaustiveness); under
/// older compilers it behaves as an ordinary value type. It also exposes a normalized
/// read-only list view so a plain string surfaces as a single text part, which keeps reads
/// uniform regardless of which case is stored.
/// </remarks>
[Union]
[CollectionBuilder(typeof(AGUIContent), nameof(Create))]
public readonly struct AGUIContent : IReadOnlyList<AGUIInputContent>
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIContent"/> struct holding plain text.
    /// </summary>
    /// <param name="text">The text.</param>
    public AGUIContent(string text) => Value = text;

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIContent"/> struct holding a list of input parts.
    /// </summary>
    /// <param name="parts">The content parts.</param>
    public AGUIContent(IList<AGUIInputContent> parts) => Value = parts;

    /// <summary>
    /// Gets the underlying value, which is either a <see cref="string"/> or an
    /// <see cref="IList{T}"/> of <see cref="AGUIInputContent"/>.
    /// </summary>
    public object? Value { get; }

    /// <summary>
    /// Gets a value indicating whether the content is stored as a plain text string.
    /// </summary>
    public bool IsText => Value is string;

    /// <summary>
    /// Returns the content as text: a string as it is, a list of parts as its text parts
    /// concatenated in order. Media parts are dropped, so this is lossy for anything but
    /// text — it is the flattening the specification permits for a consumer that can only
    /// hold a string, and it adds no placeholder for what it drops.
    /// </summary>
    public override string ToString() => Value switch
    {
        string text => text,
        IList<AGUIInputContent> parts => string.Concat(parts.OfType<AGUITextInputContent>().Select(part => part.Text)),
        _ => string.Empty,
    };

    /// <summary>
    /// Creates an <see cref="AGUIContent"/> from a span of input parts. This is the
    /// collection-builder entry point that enables C# collection-expression initialization.
    /// </summary>
    /// <param name="parts">The content parts.</param>
    /// <returns>The created content.</returns>
    public static AGUIContent Create(ReadOnlySpan<AGUIInputContent> parts) =>
        new((IList<AGUIInputContent>)parts.ToArray());

    /// <summary>
    /// Converts a string to an <see cref="AGUIContent"/>.
    /// </summary>
    /// <param name="text">The text.</param>
    public static implicit operator AGUIContent(string text) => new(text);

    /// <summary>
    /// Converts a list of input parts to an <see cref="AGUIContent"/>.
    /// </summary>
    /// <param name="parts">The content parts.</param>
    public static implicit operator AGUIContent(List<AGUIInputContent> parts) => new(parts);

    /// <summary>
    /// Converts an array of input parts to an <see cref="AGUIContent"/>.
    /// </summary>
    /// <param name="parts">The content parts.</param>
    public static implicit operator AGUIContent(AGUIInputContent[] parts) => new(parts);

    private IReadOnlyList<AGUIInputContent> Parts => Value switch
    {
        IList<AGUIInputContent> parts => new ReadOnlyView(parts),
        string text => new[] { (AGUIInputContent)new AGUITextInputContent { Text = text } },
        _ => Array.Empty<AGUIInputContent>(),
    };

    /// <inheritdoc />
    public int Count => Parts.Count;

    /// <inheritdoc />
    public AGUIInputContent this[int index] => Parts[index];

    /// <inheritdoc />
    public IEnumerator<AGUIInputContent> GetEnumerator() => Parts.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    private sealed class ReadOnlyView : IReadOnlyList<AGUIInputContent>
    {
        private readonly IList<AGUIInputContent> _parts;

        public ReadOnlyView(IList<AGUIInputContent> parts) => _parts = parts;

        public int Count => _parts.Count;

        public AGUIInputContent this[int index] => _parts[index];

        public IEnumerator<AGUIInputContent> GetEnumerator() => _parts.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => _parts.GetEnumerator();
    }
}
