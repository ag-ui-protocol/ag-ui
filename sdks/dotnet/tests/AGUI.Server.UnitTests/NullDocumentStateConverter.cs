using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Server.UnitTests;

internal sealed class NullDocumentStateConverter : JsonConverter<DocumentState>
{
    public override DocumentState? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        reader.Skip();
        return null;
    }

    public override void Write(Utf8JsonWriter writer, DocumentState value, JsonSerializerOptions options) => throw new NotSupportedException();
}
