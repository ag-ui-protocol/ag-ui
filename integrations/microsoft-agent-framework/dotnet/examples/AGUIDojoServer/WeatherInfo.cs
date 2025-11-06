using System.Text.Json.Serialization;

namespace AGUIDojoServer;

internal sealed class WeatherInfo
{
    [JsonPropertyName("temperature")]
    public int Temperature { get; set; }

    [JsonPropertyName("feelsLike")]
    public int FeelsLike { get; set; }

    [JsonPropertyName("conditions")]
    public string Conditions { get; set; } = string.Empty;

    [JsonPropertyName("humidity")]
    public int Humidity { get; set; }

    [JsonPropertyName("windSpeed")]
    public int WindSpeed { get; set; }
}
