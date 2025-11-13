using AGUIDojoServer;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting.AGUI.AspNetCore;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpLogging(logging =>
{
    logging.LoggingFields = HttpLoggingFields.RequestPropertiesAndHeaders |
        HttpLoggingFields.RequestBody |
        HttpLoggingFields.ResponsePropertiesAndHeaders |
        HttpLoggingFields.ResponseBody;
    logging.RequestBodyLogLimit = int.MaxValue;
    logging.ResponseBodyLogLimit = int.MaxValue;
});

builder.Services.AddHttpClient().AddLogging();
builder.Services.AddAGUI();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.TypeInfoResolverChain.Add(AGUIDojoServerSerializerContext.Default));

builder.Services.AddSingleton<ChatClientAgentFactory>();

var app = builder.Build();

app.UseHttpLogging();

var agentFactory = app.Services.GetRequiredService<ChatClientAgentFactory>();

var options = app.Services.GetRequiredService<IOptions<JsonOptions>>().Value.SerializerOptions;

app.MapAGUI("/agentic_chat", agentFactory.CreateAgenticChat());
app.MapAGUI("/backend_tool_rendering", agentFactory.CreateBackendToolRendering());
app.MapAGUI("/human_in_the_loop", agentFactory.CreateHumanInTheLoop());
app.MapAGUI("/agentic_generative_ui", agentFactory.CreateAgenticGenerativeUi());
app.MapAGUI("/tool_based_generative_ui", agentFactory.CreateToolBasedGenerativeUi());
app.MapAGUI("/shared_state", agentFactory.CreateSharedState(options));

await app.RunAsync();

public partial class Program;
