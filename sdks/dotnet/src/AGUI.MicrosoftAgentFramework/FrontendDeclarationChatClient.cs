using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.MicrosoftAgentFramework;

// Runs outside the native invocation pipeline so the stock binder creates and persists
// approval requests even for declaration-only tools supplied by AG-UI clients.
internal sealed class FrontendDeclarationChatClient(IChatClient innerClient, IReadOnlySet<string> frontendNames) : DelegatingChatClient(innerClient)
{
    public override Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        => base.GetResponseAsync(messages, Configure(options), cancellationToken);

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (ChatResponseUpdate update in base.GetStreamingResponseAsync(messages, Configure(options), cancellationToken).ConfigureAwait(false))
        {
            yield return update;
        }
    }

    private ChatOptions? Configure(ChatOptions? options)
    {
        if (options?.Tools is null)
        {
            return options;
        }
        ChatOptions copy = options.Clone();
        copy.Tools = options.Tools.Select(tool => tool is AIFunctionDeclaration declaration && tool is not AIFunction && frontendNames.Contains(tool.Name)
            ? (AITool)new ApprovalRequiredAIFunction(new FrontendFunction(declaration)) : tool).ToList();
        return copy;
    }

    private sealed class FrontendFunction(AIFunctionDeclaration declaration) : AIFunction
    {
        public override string Name => declaration.Name;
        public override string Description => declaration.Description;
        public override JsonElement JsonSchema => declaration.JsonSchema;
        public override JsonElement? ReturnJsonSchema => declaration.ReturnJsonSchema;
        public override IReadOnlyDictionary<string, object?> AdditionalProperties => declaration.AdditionalProperties;
        protected override ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Frontend tools must execute on the client and return their original result.");
    }
}
