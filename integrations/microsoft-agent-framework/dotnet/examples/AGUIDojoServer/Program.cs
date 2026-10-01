using AGUIDojoServer;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.Extensions.Options;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpLogging(logging =>
{
    logging.LoggingFields = HttpLoggingFields.RequestPropertiesAndHeaders | HttpLoggingFields.RequestBody
        | HttpLoggingFields.ResponsePropertiesAndHeaders | HttpLoggingFields.ResponseBody;
    logging.RequestBodyLogLimit = int.MaxValue;
    logging.ResponseBodyLogLimit = int.MaxValue;
});

builder.Services.AddHttpClient().AddLogging();
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.TypeInfoResolverChain.Add(AGUIDojoServerSerializerContext.Default));
builder.Services.AddAGUIServer();

// predictive_state_updates relies on invocable function bypassing: write_document is saved in the
// server session while the client runs confirm_changes, and is executed when the client continues the
// same thread in a new HTTP request. That needs a session store, keyed by the agent's name so
// MapAGUIServer can find it. The in-memory store is fine for the Dojo; it is unbounded and does not
// survive restarts, so use a persistent store (and per-caller isolation) in production.
builder.Services.AddKeyedSingleton<AgentSessionStore>("PredictiveStateUpdatesAgent", new InMemoryAgentSessionStore());

WebApplication app = builder.Build();

app.UseHttpLogging();

// Initialize the factory
ChatClientAgentFactory.Initialize(app.Configuration);

// Map the AG-UI agent endpoints for different scenarios
app.MapAGUIServer("/agentic_chat", ChatClientAgentFactory.CreateAgenticChat());

app.MapAGUIServer("/backend_tool_rendering", ChatClientAgentFactory.CreateBackendToolRendering());

app.MapAGUIServer("/human_in_the_loop", ChatClientAgentFactory.CreateHumanInTheLoop());

app.MapAGUIServer("/tool_based_generative_ui", ChatClientAgentFactory.CreateToolBasedGenerativeUI());

var jsonOptions = app.Services.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>();
app.MapAGUIServer("/agentic_generative_ui", ChatClientAgentFactory.CreateAgenticUI(jsonOptions.Value.SerializerOptions));

app.MapAGUIServer("/shared_state", ChatClientAgentFactory.CreateSharedState(jsonOptions.Value.SerializerOptions));

app.MapAGUIServer("/predictive_state_updates", ChatClientAgentFactory.CreatePredictiveStateUpdates(jsonOptions.Value.SerializerOptions));

await app.RunAsync();

public partial class Program { }
