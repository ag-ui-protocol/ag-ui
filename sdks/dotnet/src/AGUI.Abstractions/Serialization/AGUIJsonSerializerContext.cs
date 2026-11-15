using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Source-generated JSON serializer context for AG-UI types.
/// Types are added incrementally as each slice is implemented.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="JsonIgnoreCondition.WhenWritingNull"/> remains the context-wide default.
/// AG-UI wire types also put an ignore condition on each nullable property, normally
/// <c>[JsonIgnore(WhenWritingNull)]</c>. This keeps optional fields absent even when
/// a host inserts this context into its own <see cref="JsonSerializerOptions"/>.
/// Required null values, such as <c>CustomEvent.Value</c>, retain their explicit rule.
/// </para>
/// <para>
/// The context's <see cref="JsonSerializerContext.Options"/> do not travel with it
/// into host-owned options. The per-property attributes do, so inserting the bare
/// context still omits optional nulls. Prefer
/// <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/> when composing AG-UI
/// types into caller-owned options: it also covers nullable properties without an
/// explicit ignore condition. <c>NullOmissionTest</c> verifies both paths.
/// </para>
/// <para>
/// Guarded by <c>NullOmissionTest</c> in <c>AGUI.Abstractions.UnitTests</c>, which walks
/// every wire type by reflection and fails on any <c>null</c> the contract does not permit.
/// Properties that need <see cref="JsonIgnoreCondition.WhenWritingDefault"/> instead (a
/// non-nullable <see cref="JsonElement"/>, say) still declare it explicitly.
/// </para>
/// </remarks>
[JsonSerializable(typeof(BaseEvent))]
[JsonSerializable(typeof(RunStartedEvent))]
[JsonSerializable(typeof(RunFinishedEvent))]
[JsonSerializable(typeof(RunErrorEvent))]
[JsonSerializable(typeof(StepStartedEvent))]
[JsonSerializable(typeof(StepFinishedEvent))]
[JsonSerializable(typeof(TokenUsage))]
[JsonSerializable(typeof(IList<TokenUsage>))]
[JsonSerializable(typeof(AGUIInterrupt))]
[JsonSerializable(typeof(IList<AGUIInterrupt>))]
[JsonSerializable(typeof(AGUIResume))]
[JsonSerializable(typeof(IList<AGUIResume>))]
[JsonSerializable(typeof(AGUIContext))]
[JsonSerializable(typeof(IList<AGUIContext>))]
[JsonSerializable(typeof(RunFinishedOutcome))]
[JsonSerializable(typeof(RunFinishedSuccessOutcome))]
[JsonSerializable(typeof(RunFinishedInterruptOutcome))]
[JsonSerializable(typeof(RunFinishedCancelledOutcome))]
[JsonSerializable(typeof(SubagentStartedEvent))]
[JsonSerializable(typeof(SubagentFinishedEvent))]
[JsonSerializable(typeof(SubagentErrorEvent))]
[JsonSerializable(typeof(SubagentFinishedOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuccessOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuspendedOutcome))]
[JsonSerializable(typeof(AGUIToolApprovalPayload))]
[JsonSerializable(typeof(AGUIToolApprovalResumePayload))]
[JsonSerializable(typeof(AGUIToolCallInfo))]
[JsonSerializable(typeof(RunAgentInput))]
[JsonSerializable(typeof(TextMessageStartEvent))]
[JsonSerializable(typeof(TextMessageContentEvent))]
[JsonSerializable(typeof(TextMessageEndEvent))]
[JsonSerializable(typeof(AGUIMessage))]
[JsonSerializable(typeof(AGUIUserMessage))]
[JsonSerializable(typeof(AGUIAssistantMessage))]
[JsonSerializable(typeof(AGUISystemMessage))]
[JsonSerializable(typeof(AGUIDeveloperMessage))]
[JsonSerializable(typeof(AGUIToolMessage))]
[JsonSerializable(typeof(AGUIActivityMessage))]
[JsonSerializable(typeof(AGUIReasoningMessage))]
[JsonSerializable(typeof(AGUIToolCall))]
[JsonSerializable(typeof(AGUIToolCallFunction))]
[JsonSerializable(typeof(AGUIInputContent))]
[JsonSerializable(typeof(AGUITextInputContent))]
[JsonSerializable(typeof(AGUIImageInputContent))]
[JsonSerializable(typeof(AGUIAudioInputContent))]
[JsonSerializable(typeof(AGUIVideoInputContent))]
[JsonSerializable(typeof(AGUIDocumentInputContent))]
[JsonSerializable(typeof(AGUIInputContentSource))]
[JsonSerializable(typeof(AGUIInputContentDataSource))]
[JsonSerializable(typeof(AGUIInputContentUrlSource))]
[JsonSerializable(typeof(AGUIInputContentFileSource))]
[JsonSerializable(typeof(ToolCallStartEvent))]
[JsonSerializable(typeof(ToolCallArgsEvent))]
[JsonSerializable(typeof(ToolCallEndEvent))]
[JsonSerializable(typeof(ToolCallResultEvent))]
[JsonSerializable(typeof(AGUITool))]
[JsonSerializable(typeof(StateSnapshotEvent))]
[JsonSerializable(typeof(StateDeltaEvent))]
[JsonSerializable(typeof(ReasoningStartEvent))]
[JsonSerializable(typeof(ReasoningMessageStartEvent))]
[JsonSerializable(typeof(ReasoningMessageContentEvent))]
[JsonSerializable(typeof(ReasoningMessageEndEvent))]
[JsonSerializable(typeof(ReasoningMessageChunkEvent))]
[JsonSerializable(typeof(TextMessageChunkEvent))]
[JsonSerializable(typeof(ToolCallChunkEvent))]
[JsonSerializable(typeof(ReasoningEndEvent))]
[JsonSerializable(typeof(ReasoningEncryptedValueEvent))]
[JsonSerializable(typeof(ActivitySnapshotEvent))]
[JsonSerializable(typeof(ActivityDeltaEvent))]
[JsonSerializable(typeof(CustomEvent))]
[JsonSerializable(typeof(RawEvent))]
[JsonSerializable(typeof(MessagesSnapshotEvent))]
[JsonSerializable(typeof(SubagentStartedEvent))]
[JsonSerializable(typeof(SubagentFinishedEvent))]
[JsonSerializable(typeof(SubagentFinishedOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuccessOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuspendedOutcome))]
[JsonSerializable(typeof(SubagentErrorEvent))]
[JsonSerializable(typeof(AgentCapabilities))]
[JsonSerializable(typeof(IdentityCapabilities))]
[JsonSerializable(typeof(TransportCapabilities))]
[JsonSerializable(typeof(ToolsCapabilities))]
[JsonSerializable(typeof(OutputCapabilities))]
[JsonSerializable(typeof(StateCapabilities))]
[JsonSerializable(typeof(MultiAgentCapabilities))]
[JsonSerializable(typeof(SubagentInfo))]
[JsonSerializable(typeof(ReasoningCapabilities))]
[JsonSerializable(typeof(MultimodalCapabilities))]
[JsonSerializable(typeof(MultimodalInputCapabilities))]
[JsonSerializable(typeof(MultimodalOutputCapabilities))]
[JsonSerializable(typeof(ExecutionCapabilities))]
[JsonSerializable(typeof(HumanInTheLoopCapabilities))]
[JsonSerializable(typeof(IDictionary<string, object?>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
// A tool result handed to AsAGUIMessages is an `object`, so System.Text.Json resolves its
// runtime type polymorphically and needs metadata for whatever primitives it contains.
// `int` used to arrive here by accident, pulled in by ExecutionCapabilities.MaxIterations
// when that property was `int?`; the generated capability types spell it `long?`, so the
// registration has to be explicit or a tool result containing a whole number throws
// NotSupportedException at serialization time. AGUIChatMessageExtensionsTest's
// AsAGUIMessages_ToolResultObjectContent_SerializesToJson pins this.
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(JsonElement?))]
[JsonSerializable(typeof(JsonObject))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
public partial class AGUIJsonSerializerContext : JsonSerializerContext
{
}
