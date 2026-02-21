using System.Collections.Immutable;
using System.Text.Json;
using System.Threading.Channels;
using AGUIDotnet.Agent;
using AGUIDotnet.Events;
using AGUIDotnet.Types;

namespace AGUIDotnet.Tests;

// Simple agent for testing purposes that allows us to delegate the RunAsync method to a provided function.
public class DelegatingAgent(Func<RunAgentInput, ChannelWriter<BaseEvent>, CancellationToken, Task> func) : IAGUIAgent
{
	public async Task RunAsync(RunAgentInput input, ChannelWriter<BaseEvent> events, CancellationToken cancellationToken = default)
	{
		await func(input, events, cancellationToken).ConfigureAwait(false);
	}
}

public class AgentExtensionsTests
{
	[Fact]
	public void RunToCompletionAsyncSupportsNoOp()
	{
		var agent = new DelegatingAgent((input, events, cancellationToken) =>
		{
			return Task.CompletedTask;
		});
		var input = new RunAgentInput
		{
			ThreadId = "test-thread",
			RunId = "test-run",
			State = JsonDocument.Parse("{}").RootElement,
			Messages = [],
			Context = [],
			ForwardedProps = JsonDocument.Parse("{}").RootElement,
			Tools = []
		};

		var events = agent.RunToCompletionAsync(input).ToBlockingEnumerable().ToImmutableList();

		Assert.Empty(events);
	}

	[Fact]
	public void RunToCompletionAsyncHandlesAgentChannelCompletion()
	{
		var agent = new DelegatingAgent((input, events, cancellationToken) =>
		   {
			   // Complete the channel ourselves
			   events.Complete();

			   return Task.CompletedTask;
		   });

		var input = new RunAgentInput
		{
			ThreadId = "test-thread",
			RunId = "test-run",
			State = JsonDocument.Parse("{}").RootElement,
			Messages = [],
			Context = [],
			ForwardedProps = JsonDocument.Parse("{}").RootElement,
			Tools = []
		};

		var events = agent.RunToCompletionAsync(input).ToBlockingEnumerable().ToImmutableList();

		Assert.Empty(events);
	}

	[Theory]
	[InlineData("test-thread", "test-run")]
	[InlineData("another-thread", "another-run")]
	public void RunToCompletionAsyncDispatchesExactInputToAgent(string threadId, string runId)
	{
		var input = new RunAgentInput
		{
			ThreadId = threadId,
			RunId = runId,
			State = JsonDocument.Parse("{}").RootElement,
			Messages = [],
			Context = [],
			ForwardedProps = JsonDocument.Parse("{}").RootElement,
			Tools = []
		};

		var agent = new DelegatingAgent((actualInput, events, cancellationToken) =>
		{
			Assert.Equal(input.ThreadId, actualInput.ThreadId);
			Assert.Equal(input.RunId, actualInput.RunId);
			Assert.Equal(input.State.ToString(), actualInput.State.ToString());
			Assert.Equal(input.Messages, actualInput.Messages);
			Assert.Equal(input.Context, actualInput.Context);
			Assert.Equal(input.ForwardedProps.ToString(), actualInput.ForwardedProps.ToString());
			Assert.Equal(input.Tools, actualInput.Tools);

			return Task.CompletedTask;
		});

		var events = agent.RunToCompletionAsync(input).ToBlockingEnumerable().ToImmutableList();
	}
}
