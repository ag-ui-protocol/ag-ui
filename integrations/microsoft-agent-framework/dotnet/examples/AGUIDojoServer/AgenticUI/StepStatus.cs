using System.Text.Json.Serialization;

namespace AGUIDojoServer.AgenticUI;

// The Dojo planner compares statuses in lowercase ("pending" / "completed").
[JsonConverter(typeof(JsonStringEnumConverter<StepStatus>))]
internal enum StepStatus
{
    [JsonStringEnumMemberName("pending")]
    Pending,

    [JsonStringEnumMemberName("completed")]
    Completed
}
