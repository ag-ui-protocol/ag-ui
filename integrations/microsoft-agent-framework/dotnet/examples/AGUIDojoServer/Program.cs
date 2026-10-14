using AGUIDojoServer;
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
builder.Services.AddAGUIServer();

WebApplication app = builder.Build();

app.UseHttpLogging();

// Initialize the factory
ChatClientAgentFactory.Initialize(app.Configuration);

// Map the AG-UI agent endpoints for different scenarios
app.MapAGUIServer("/agentic_chat", ChatClientAgentFactory.CreateAgenticChat());

app.MapAGUIServer("/backend_tool_rendering", ChatClientAgentFactory.CreateBackendToolRendering());

app.MapAGUIServer("/human_in_the_loop", ChatClientAgentFactory.CreateHumanInTheLoop());

app.MapAGUIServer("/tool_based_generative_ui", ChatClientAgentFactory.CreateToolBasedGenerativeUI());

// The state demos emit STATE_SNAPSHOT / STATE_DELTA through AGUIStreamOptions mappings attached as
// endpoint metadata, which MapAGUIServer reads for each request.
app.MapAGUIServer("/agentic_generative_ui", ChatClientAgentFactory.CreateAgenticUI())
    .WithMetadata(ChatClientAgentFactory.CreateAgenticUIStreamOptions());

app.MapAGUIServer("/shared_state", ChatClientAgentFactory.CreateSharedState())
    .WithMetadata(ChatClientAgentFactory.CreateSharedStateStreamOptions());

var jsonOptions = app.Services.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>();
app.MapAGUIServer("/predictive_state_updates", ChatClientAgentFactory.CreatePredictiveStateUpdates())
    .WithMetadata(ChatClientAgentFactory.CreatePredictiveStateUpdatesStreamOptions(jsonOptions.Value.SerializerOptions));

await app.RunAsync();

public partial class Program { }
