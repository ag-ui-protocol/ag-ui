using System.Diagnostics.CodeAnalysis;
using System.Net.Http;
using System.Text.Json;

namespace AGUI.Client;

/// <summary>
/// Options for constructing an <see cref="AGUIChatClient"/>.
/// </summary>
public sealed class AGUIChatClientOptions
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIChatClientOptions"/> class. The
    /// <see cref="Transport"/> must be set via an object initializer.
    /// </summary>
    public AGUIChatClientOptions()
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIChatClientOptions"/> class that talks to an
    /// AG-UI endpoint over HTTP using the supplied <see cref="HttpClient"/>.
    /// </summary>
    /// <param name="httpClient">The HTTP client to use for communication.</param>
    /// <param name="endpoint">The AG-UI server endpoint URL.</param>
    /// <remarks>
    /// The caller owns <paramref name="httpClient"/>. Server-Sent Events is used unless the client's
    /// handler pipeline already includes an <see cref="AGUIEventStreamHandler"/> that negotiates another
    /// format (for example, wired up to request protobuf).
    /// </remarks>
    [SetsRequiredMembers]
    public AGUIChatClientOptions(HttpClient httpClient, string endpoint)
    {
        ArgumentNullThrowHelper.ThrowIfNull(httpClient);
        ArgumentNullThrowHelper.ThrowIfNull(endpoint);

        Transport = new AGUIHttpTransport(httpClient, endpoint);
    }

    /// <summary>
    /// Gets the transport used to send AG-UI protocol requests.
    /// </summary>
    public required IAGUITransport Transport { get; init; }

    /// <summary>
    /// Gets the JSON serializer options for AG-UI payloads and chat-message conversion. When
    /// <see langword="null"/>, the AG-UI source-generated defaults are used.
    /// </summary>
    public JsonSerializerOptions? JsonSerializerOptions { get; init; }

    /// <summary>
    /// Gets the highest protocol version the peer is known to speak, when it is pinned
    /// below this client. When <see langword="null"/> — the default — the peer is treated
    /// as current.
    /// </summary>
    /// <remarks>
    /// The only thing this gates today is the in-band version declaration: a peer pinned
    /// below the line this client speaks predates <c>RunAgentInput.protocolVersion</c>
    /// entirely, and an unrecognised input member is exactly what a strict old parser could
    /// reject, so the field is left off for one. Mirrors the TypeScript client's
    /// <c>maxProtocolVersion</c>. A value this client cannot read is treated as a current
    /// peer, because silence about a peer is not evidence that it is old.
    /// </remarks>
    public string? MaxProtocolVersion { get; init; }
}
