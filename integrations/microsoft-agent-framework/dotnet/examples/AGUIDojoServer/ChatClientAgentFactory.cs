using System.ComponentModel;
using System.Text.Json;
using AGUIDojoServer.AgenticUI;
using AGUIDojoServer.BackendToolRendering;
using AGUIDojoServer.PredictiveStateUpdates;
using AGUIDojoServer.SharedState;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using ChatClient = OpenAI.Chat.ChatClient;

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

        return chatClient.AsIChatClient().CreateAIAgent(
            name: "AgenticChat",
            description: "A simple chat agent using OpenAI");
    }

    public static ChatClientAgent CreateBackendToolRendering()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsIChatClient().CreateAIAgent(
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

        return chatClient.AsIChatClient().CreateAIAgent(
            name: "HumanInTheLoopAgent",
            description: "An agent that involves human feedback in its decision-making process using OpenAI");
    }

    public static ChatClientAgent CreateToolBasedGenerativeUI()
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        return chatClient.AsIChatClient().CreateAIAgent(
            name: "ToolBasedGenerativeUIAgent",
            description: "An agent that uses tools to generate user interfaces using OpenAI");
    }

    public static AIAgent CreateAgenticUI(JsonSerializerOptions options)
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);
        var baseAgent = chatClient.AsIChatClient().CreateAIAgent(new ChatClientAgentOptions
        {
            Name = "AgenticUIAgent",
            Description = "An agent that generates agentic user interfaces using OpenAI",
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
            ChatOptions = new ChatOptions
            {
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

        return new AgenticUIAgent(baseAgent, options);
    }

    public static AIAgent CreateSharedState(JsonSerializerOptions options)
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        var baseAgent = chatClient.AsIChatClient().CreateAIAgent(
            name: "SharedStateAgent",
            description: "An agent that demonstrates shared state patterns using OpenAI");

        return new SharedStateAgent(baseAgent, options);
    }

    public static AIAgent CreatePredictiveStateUpdates(JsonSerializerOptions options)
    {
        ChatClient chatClient = s_openAIClient!.GetChatClient(s_modelName!);

        var baseAgent = chatClient.AsIChatClient().CreateAIAgent(new ChatClientAgentOptions
        {
            Name = "PredictiveStateUpdatesAgent",
            Description = "An agent that demonstrates predictive state updates using OpenAI",
            Instructions = """
                You are a document editor assistant. When asked to write or edit content:
                
                IMPORTANT:
                - Use the `write_document` tool with the full document text in Markdown format
                - Format the document extensively so it's easy to read
                - You can use all kinds of markdown (headings, lists, bold, etc.)
                - However, do NOT use italic or strike-through formatting
                - You MUST write the full document, even when changing only a few words
                - When making edits to the document, try to make them minimal - do not change every word
                - Keep stories SHORT!
                - After you are done writing the document you MUST call a confirm_changes tool after you call write_document
                
                After the user confirms the changes, provide a brief summary of what you wrote.
                """,
            ChatOptions = new ChatOptions
            {
                Tools = [
                    AIFunctionFactory.Create(
                        WriteDocument,
                        name: "write_document",
                        description: "Write a document. Use markdown formatting to format the document.",
                        AGUIDojoServerSerializerContext.Default.Options)
                ]
            }
        });

        return new PredictiveStateUpdatesAgent(baseAgent, options);
    }

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
        // Simply return success - the document is tracked via state updates
        return "Document written successfully";
    }
}
