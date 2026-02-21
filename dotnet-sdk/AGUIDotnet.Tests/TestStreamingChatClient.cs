using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;

namespace AGUIDotnet.Tests;

/// <summary>
/// A test implementation of IChatClient that allows simulating streaming responses.
/// </summary>
internal sealed class TestStreamingChatClient : IChatClient
{
    private readonly IKeyedServiceProvider _serviceProvider;
    private readonly Func<IKeyedServiceProvider, IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> _getStreamingResponseAsync;

    /// <summary>
    /// Creates a new TestStreamingChatClient that allows configuring both sync and streaming responses.
    /// </summary>
    /// <param name="serviceProvider">The service provider to use for service resolution</param>
    /// <param name="getResponseAsync">Function to generate synchronous responses</param>
    /// <param name="getStreamingResponseAsync">Function to generate streaming responses</param>
    public TestStreamingChatClient(
        IKeyedServiceProvider serviceProvider,
        Func<IKeyedServiceProvider, IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, IAsyncEnumerable<ChatResponseUpdate>> getStreamingResponseAsync)
    {
        _serviceProvider = serviceProvider;
        _getStreamingResponseAsync = getStreamingResponseAsync;
    }

    public void Dispose()
    {
    }

    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException("This client is intended for streaming responses only. Use GetStreamingResponseAsync instead.");
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        return _getStreamingResponseAsync(_serviceProvider, messages, options, cancellationToken);
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        return _serviceProvider.GetKeyedService(serviceType, serviceKey);
    }
}
