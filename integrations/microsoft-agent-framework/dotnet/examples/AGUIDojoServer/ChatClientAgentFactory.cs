using System.ComponentModel;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using AGUIDojoServer.AgenticUI;
using AGUIDojoServer.BackendToolRendering;
using AGUIDojoServer.PredictiveStateUpdates;
using AGUIDojoServer.SharedState;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenAI.Chat;

namespace AGUIDojoServer;

internal static class ChatClientAgentFactory
{
    private static OpenAIClient? s_openAIClient;
    private static string? s_modelName;

    public static void Initialize(IConfiguration configuration)
    {
        s_modelName = configuration["OPENAI_CHAT_MODEL_ID"] ?? "gpt-4o";
        string? apiKey = configuration["OPENAI_API_KEY"];
        string? baseUrl = configuration["OPENAI_BASE_URL"];

        var options = new OpenAIClientOptions();
        if (!string.IsNullOrEmpty(baseUrl))
        {
            options.Endpoint = new Uri(baseUrl);
        }

        s_openAIClient = new OpenAIClient(
            new System.ClientModel.ApiKeyCredential(apiKey ?? ""),
            options);
    }

    public static ChatClientAgent CreateAgenticChat()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsAIAgent(
            name: "AgenticChat",
            description: "A simple chat agent using OpenAI");
    }

    public static ChatClientAgent CreateBackendToolRendering()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsAIAgent(
            name: "BackendToolRenderer",
            description: "An agent that can render backend tools using OpenAI",
            tools: [AIFunctionFactory.Create(
                GetWeather,
                name: "get_weather",
                description: "Get the weather for a given location.",
                AGUIDojoServerSerializerContext.Default.Options)]);
    }

    public static ChatClientAgent CreateHumanInTheLoop()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsAIAgent(
            name: "HumanInTheLoopAgent",
            description: "An agent that involves human feedback in its decision-making process using OpenAI");
    }

    public static ChatClientAgent CreateToolBasedGenerativeUI()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsAIAgent(
            name: "ToolBasedGenerativeUIAgent",
            description: "An agent that uses tools to generate user interfaces using OpenAI");
    }

    public static ChatClientAgent CreateAgenticUI()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);
        return chatClient.AsAIAgent(new ChatClientAgentOptions
        {
            Name = "AgenticUIAgent",
            Description = "An agent that generates agentic user interfaces using OpenAI",
            ChatOptions = new ChatOptions
            {
                Instructions = """
                    When planning use tools only, without any other messages.
                    IMPORTANT:
                    - Use the `create_plan` tool to set the initial state of the steps
                    - Use the `update_plan_step` tool to update the status of each step
                    - Do NOT repeat the plan or summarise it in a message
                    - Do NOT confirm the creation or updates in a message
                    - Do NOT ask the user for additional information or next steps
                    - Do NOT leave a plan hanging, always complete the plan via `update_plan_step` if one is ongoing.
                    - Continue calling update_plan_step until all steps are marked as completed.

                    Only one plan can be active at a time, so do not call the `create_plan` tool
                    again until all the steps in current plan are completed.
                    """,
                Tools = [
                    AIFunctionFactory.Create(
                        AgenticPlanningTools.CreatePlan,
                        name: "create_plan",
                        description: "Create a plan with multiple steps.",
                        AGUIDojoServerSerializerContext.Default.Options),
                    AIFunctionFactory.Create(
                        AgenticPlanningTools.UpdatePlanStepAsync,
                        name: "update_plan_step",
                        description: "Update a step in the plan with new description or status.",
                        AGUIDojoServerSerializerContext.Default.Options)
                ],
                AllowMultipleToolCalls = false
            }
        });
    }

    // MAF 1.23's AG-UI hosting (AGUI.Server 1.0) no longer turns DataContent into state events.
    // State comes from tool results instead: create_plan returns the whole plan (STATE_SNAPSHOT) and
    // update_plan_step returns JSON Patch operations (STATE_DELTA).
    public static AGUIStreamOptions CreateAgenticUIStreamOptions() =>
        new AGUIStreamOptions()
            .MapResultAsStateSnapshot("create_plan")
            .MapResultAsStateDelta("update_plan_step");

    public static AIAgent CreateSharedState()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        var baseAgent = chatClient.AsAIAgent(new ChatClientAgentOptions
        {
            Name = "SharedStateAgent",
            Description = "An agent that demonstrates shared state patterns using OpenAI",
            ChatOptions = new ChatOptions
            {
                Instructions = """
                    You are a helpful recipe assistant that maintains a shared recipe state with the user.

                    IMPORTANT:
                    - When the user asks you to create, change, or improve a recipe, call the `generate_recipe`
                      tool with a COMPLETE recipe: a title, skill_level, cooking_time, special_preferences, the
                      full list of ingredients (each with an icon, name and amount) and the step-by-step
                      instructions.
                    - Always include every ingredient the recipe needs, keeping any the user already added.
                    - When the user only asks a question about the recipe, answer in plain text and do NOT call the tool.
                    - After calling the tool, summarize the changes in at most two sentences.
                    """,
                Tools = [
                    AIFunctionFactory.Create(
                        GenerateRecipe,
                        name: "generate_recipe",
                        description: "Generate or update the shared recipe and display it to the user.",
                        AGUIDojoServerSerializerContext.Default.Options)
                ]
            }
        });

        // The wrapper feeds the client's current recipe to the model (input side of shared state).
        return new SharedStateAgent(baseAgent);
    }

    // Output side of shared state: each generate_recipe result ({"recipe": {...}}) becomes a STATE_SNAPSHOT.
    public static AGUIStreamOptions CreateSharedStateStreamOptions() =>
        new AGUIStreamOptions().MapResultAsStateSnapshot("generate_recipe");

    public static ChatClientAgent CreatePredictiveStateUpdates()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsAIAgent(new ChatClientAgentOptions
        {
            Name = "PredictiveStateUpdatesAgent",
            Description = "An agent that demonstrates predictive state updates using OpenAI",
            ChatOptions = new ChatOptions
            {
                Instructions = """
                    You are a document editor assistant. When asked to write or edit content:

                    IMPORTANT:
                    - Use the `write_document_local` tool with the full document text in Markdown format
                    - Format the document extensively so it's easy to read
                    - You can use all kinds of markdown (headings, lists, bold, etc.)
                    - However, do NOT use italic or strike-through formatting
                    - You MUST write the full document, even when changing only a few words
                    - When making edits to the document, try to make them minimal - do not change every word
                    - Keep stories SHORT!

                    After the user confirms the changes, provide a brief summary of what you wrote.
                    """,
                Tools = [
                    // Declaration only: the agent's function-invocation loop must not run write_document_local.
                    // The model's call ends the turn and reaches the AG-UI stream, where
                    // CreatePredictiveStateUpdatesStreamOptions turns it into document state and a
                    // confirm_changes call for the client's approval modal.
                    AIFunctionFactory.Create(
                        WriteDocument,
                        name: "write_document_local",
                        description: "Write a document. Use markdown formatting to format the document.",
                        AGUIDojoServerSerializerContext.Default.Options).AsDeclarationOnly()
                ]
            }
        });
    }

    public static AGUIStreamOptions CreatePredictiveStateUpdatesStreamOptions(JsonSerializerOptions jsonSerializerOptions) =>
        new AGUIStreamOptions().MapCall("write_document_local", fcc => PredictiveStateEvents(fcc, jsonSerializerOptions));

    // An iterator, so each growing snapshot is built only when the stream sends it. Collecting them
    // first would hold every prefix of the document in memory at once.
    private static IEnumerable<BaseEvent> PredictiveStateEvents(FunctionCallContent fcc, JsonSerializerOptions jsonSerializerOptions)
    {
        if (fcc.Arguments?.TryGetValue("document", out var documentValue) != true ||
            documentValue?.ToString() is not { } document)
        {
            yield break;
        }

        // Stream the document into state in growing chunks, so the editor fills in progressively.
        const int ChunkSize = 10;
        for (int end = Math.Min(ChunkSize, document.Length); ; end = Math.Min(end + ChunkSize, document.Length))
        {
            var snapshot = JsonSerializer.SerializeToElement(
                new DocumentState { Document = document[..end] },
                jsonSerializerOptions.GetTypeInfo(typeof(DocumentState)));
            yield return new StateSnapshotEvent { Snapshot = snapshot };
            if (end == document.Length)
            {
                break;
            }
        }

        // Complete write_document_local (its document is now in state), so the only call the client
        // sees pending is confirm_changes.
        yield return new ToolCallResultEvent
        {
            MessageId = Guid.NewGuid().ToString("N"),
            ToolCallId = fcc.CallId,
            Content = "Document written.",
            Role = "tool",
        };

        // Ask the client to confirm. The Dojo registers confirm_changes as a human-in-the-loop tool
        // and renders the accept/reject modal for it. The call gets its own assistant message id.
        var confirmCallId = Guid.NewGuid().ToString("N");
        yield return new ToolCallStartEvent { ToolCallId = confirmCallId, ToolCallName = "confirm_changes", ParentMessageId = Guid.NewGuid().ToString("N") };
        yield return new ToolCallArgsEvent { ToolCallId = confirmCallId, Delta = "{}" };
        yield return new ToolCallEndEvent { ToolCallId = confirmCallId };
    }

    [Description("Generate or update the shared recipe and display it to the user.")]
    private static RecipeResponse GenerateRecipe(
        [Description("The complete recipe to display.")] Recipe recipe) => new() { Recipe = recipe };

    [Description("Get the weather for a given location.")]
    private static WeatherInfo GetWeather([Description("The location to get the weather for.")] string location) => new()
    {
        Temperature = 20,
        Conditions = "sunny",
        Humidity = 50,
        WindSpeed = 10,
        FeelsLike = 25
    };

    [Description("Write a document in markdown format.")]
    private static string WriteDocument([Description("The document content to write.")] string document)
    {
        // Never invoked: the tool is declaration-only (see CreatePredictiveStateUpdates). This method only
        // supplies the tool schema.
        return "Document written successfully";
    }
}
