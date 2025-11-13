using System.Text.Json.Serialization;

namespace AGUIDojoServer;

[JsonSerializable(typeof(WeatherInfo))]
[JsonSerializable(typeof(RecipeResponse))]
[JsonSerializable(typeof(Recipe))]
[JsonSerializable(typeof(Ingredient))]
[JsonSerializable(typeof(TaskPlan))]
[JsonSerializable(typeof(TaskPlanStep))]
[JsonSerializable(typeof(UiComponentResponse))]
[JsonSerializable(typeof(UiComponent))]
[JsonSerializable(typeof(UiField))]
[JsonSerializable(typeof(RecipeState))]
[JsonSerializable(typeof(DraftDocument))]
[JsonSerializable(typeof(DraftSection))]
internal sealed partial class AGUIDojoServerSerializerContext : JsonSerializerContext
{
}
