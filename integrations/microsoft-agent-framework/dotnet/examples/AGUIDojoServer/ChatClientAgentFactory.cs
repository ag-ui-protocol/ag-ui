using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Configuration;
using OpenAI;
using OpenAI.Chat;
using ChatResponseFormat = Microsoft.Extensions.AI.ChatResponseFormat;

namespace AGUIDojoServer;

internal sealed class ChatClientAgentFactory
{
    private readonly AzureOpenAIClient _azureOpenAIClient;
    private readonly string _deploymentName;

    public ChatClientAgentFactory(IConfiguration configuration)
    {
        string? endpoint = configuration["AZURE_OPENAI_ENDPOINT"];
        string? deploymentName = configuration["AZURE_OPENAI_DEPLOYMENT_NAME"];

        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT must be provided in the environment or configuration.");
        }

        if (string.IsNullOrWhiteSpace(deploymentName))
        {
            throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT_NAME must be provided in the environment or configuration.");
        }

        _azureOpenAIClient = new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential());
        _deploymentName = deploymentName;
    }

    public ChatClientAgent CreateAgenticChat() => CreateAgent(
        name: "maf-agentic-chat",
        description: "General helper agent that demonstrates conversational capabilities for the AG-UI dojo.");

    public ChatClientAgent CreateBackendToolRendering()
    {
        var getWeatherTool = AIFunctionFactory.Create(
            ([Description("City to generate a forecast for")] string location) => GetWeatherForecast(location),
            name: "get_weather",
            description: "Fetch the weather forecast for the provided city.",
            serializerOptions: AGUIDojoServerSerializerContext.Default.Options);

        return CreateAgent(
            name: "maf-backend-tool-rendering",
            description: "Uses a backend tool to fetch weather data and render it in the dojo UI.",
            tools: [getWeatherTool]);
    }

    public ChatClientAgent CreateHumanInTheLoop() => CreateAgent(
        name: "maf-human-in-the-loop",
        description: "Before executing actions, summarise the planned work and ask the user for approval. When the user says 'approve', continue executing the plan step by step.");

    public ChatClientAgent CreateAgenticGenerativeUi()
    {
        var taskBreakdownTool = AIFunctionFactory.Create(
            ([Description("The overall task the assistant should complete")] string objective) => GenerateTaskPlan(objective),
            name: "generate_task_steps",
            description: "Break the objective into 3-4 short steps for the UI to display.",
            serializerOptions: AGUIDojoServerSerializerContext.Default.Options);

        return CreateAgent(
            name: "maf-agentic-generative-ui",
            description: "Provide step-by-step progress updates and call the generate_task_steps tool to render checkpoints in the dojo.",
            tools: [taskBreakdownTool]);
    }

    public ChatClientAgent CreateToolBasedGenerativeUi()
    {
        var uiComponentTool = AIFunctionFactory.Create(
            ([Description("The UI experience the assistant should render")] string request) => GenerateUiComponent(request),
            name: "render_custom_component",
            description: "Return a UI definition that the dojo can render.",
            serializerOptions: AGUIDojoServerSerializerContext.Default.Options);

        return CreateAgent(
            name: "maf-tool-based-generative-ui",
            description: "Design interactive UI components via the render_custom_component tool and explain how the user can interact with them.",
            tools: [uiComponentTool]);
    }

    public AIAgent CreateSharedState(JsonSerializerOptions options)
    {
        ChatClientAgent baseAgent = CreateAgent(
            name: "SharedStateAgent",
            description: "An agent that demonstrates shared state patterns using Azure OpenAI");

        return new SharedStateAgent(baseAgent, options);
    }    

    private ChatClientAgent CreateAgent(string name, string description, IEnumerable<AITool>? tools = null)
    {
        var chatClient = _azureOpenAIClient.GetChatClient(_deploymentName);
        return chatClient.CreateAIAgent(
            name: name,
            description: description,
            tools: tools?.ToArray() ?? Array.Empty<AITool>());
    }

    private static WeatherInfo GetWeatherForecast(string location)
    {
        return new WeatherInfo
        {
            Temperature = 72,
            Conditions = $"Clear skies over {location}",
            Humidity = 48,
            WindSpeed = 6,
            FeelsLike = 74
        };
    }

    private static TaskPlan GenerateTaskPlan(string objective)
    {
        return new TaskPlan
        {
            Steps =
            [
                new TaskPlanStep
                {
                    Id = "plan",
                    Title = "Plan",
                    Summary = $"Outline instructions for \"{objective}\" and gather any missing context."
                },
                new TaskPlanStep
                {
                    Id = "execute",
                    Title = "Execute",
                    Summary = "Carry out the plan and surface intermediate results for review."
                },
                new TaskPlanStep
                {
                    Id = "review",
                    Title = "Review",
                    Summary = "Summarise the outcome, highlight next steps, and confirm with the user."
                }
            ]
        };
    }

    private static UiComponentResponse GenerateUiComponent(string request)
    {
        return new UiComponentResponse
        {
            Component = new UiComponent
            {
                Title = "Configuration",
                Description = $"Controls generated to satisfy: {request}",
                Fields =
                [
                    new UiField
                    {
                        Id = "priority",
                        Label = "Priority",
                        Control = "select",
                        Options = ["High", "Medium", "Low"]
                    },
                    new UiField
                    {
                        Id = "notes",
                        Label = "Notes",
                        Control = "textarea"
                    }
                ]
            }
        };
    }

    private static RecipeState BuildRecipe(string recipeName)
    {
        return new RecipeState
        {
            Title = string.IsNullOrWhiteSpace(recipeName) ? "Sample Pasta" : recipeName,
            Ingredients =
            [
                "200g spaghetti",
                "2 cloves garlic",
                "1 tbsp olive oil",
                "Salt and pepper to taste"
            ],
            Steps =
            [
                "Bring a large pot of salted water to a boil.",
                "Cook the pasta until al dente, reserving 1/4 cup of cooking water.",
                "Sauté garlic in olive oil, toss with pasta, and adjust seasoning."
            ]
        };
    }

    private static DraftDocument DraftDocument(string topic)
    {
        return new DraftDocument
        {
            Sections =
            [
                new DraftSection
                {
                    Id = "intro",
                    Title = "Introduction",
                    Content = $"Introduce the topic \"{topic}\" and clarify the desired outcome."
                },
                new DraftSection
                {
                    Id = "details",
                    Title = "Key Points",
                    Content = "Highlight three supporting facts with short explanations."
                },
                new DraftSection
                {
                    Id = "summary",
                    Title = "Next Steps",
                    Content = "Outline the follow-up actions the reader should take after reviewing the draft."
                }
            ]
        };
    }
}
