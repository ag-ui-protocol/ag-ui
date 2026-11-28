using AGUI.Formatting;
using AGUI.Protobuf;
using AGUI.Server;
using AGUI.Server.IntegrationTests;
using Microsoft.Extensions.AI;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAGUI();
builder.Services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>();
builder.Services.AddSingleton<DelegatingStreamingChatClient>();
builder.Services.AddChatClient(sp => sp.GetRequiredService<DelegatingStreamingChatClient>())
    .UseFunctionInvocation(configure: fic => fic.TerminateOnUnknownCalls = true);

var app = builder.Build();
app.MapAGUI("/agui");
app.MapAGUI("/agui-filtered", middleware => middleware
    .Use(FilterToolCallsMiddleware.Disallow([FilterToolCallsIntegrationTest.HiddenToolName])));
app.Run();

public partial class Program { }
