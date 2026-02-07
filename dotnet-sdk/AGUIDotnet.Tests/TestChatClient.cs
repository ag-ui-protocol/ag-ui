using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;

namespace AGUIDotnet.Tests;

internal sealed class TestChatClient(
    IKeyedServiceProvider serviceProvider,
    Func<IKeyedServiceProvider, IEnumerable<ChatMessage>, ChatOptions?, CancellationToken, Task<ChatResponse>> getResponseAsync
    ) : IChatClient
{
    public void Dispose()
    {
    }

    public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        return await getResponseAsync(serviceProvider, messages, options, cancellationToken);
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        return serviceProvider.GetKeyedService(serviceType, serviceKey);
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        throw new NotImplementedException();
    }
}
