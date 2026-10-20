using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// Guards the rule that a producer omits a field with no value instead of writing
/// <c>null</c> for it.
/// </summary>
/// <remarks>
/// <para>
/// The omission is a per-property <c>[JsonIgnore(WhenWritingNull)]</c> on every nullable
/// property (emitted by the spec generator for the generated types), with
/// <c>DefaultIgnoreCondition = WhenWritingNull</c> on <see cref="AGUIJsonSerializerContext"/>
/// behind it. The context-wide setting alone is not enough: it lives on the context's own
/// options and does not travel when a host inserts the bare context into its own
/// <see cref="JsonSerializerOptions"/>, which is exactly what Microsoft Agent Framework's
/// <c>ConfigureAGUIJsonOptions</c> does. Without the attributes that host wrote
/// <c>"parentRunId": null</c> on RUN_STARTED and the TypeScript client rejected the run.
/// </para>
/// <para>
/// The sweeps discover the types to check by reflection, so a wire type added later is
/// covered without anyone editing this file, and they run through the context itself, through
/// <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/>, and through host-owned options
/// holding only the bare context.
/// </para>
/// </remarks>
public sealed class NullOmissionTest
{
    /// <summary>
    /// The one place a null is the contract rather than an oversight:
    /// CUSTOM.value is REQUIRED and any JSON value — including null — is legal
    /// for it. Omitting it would produce an event missing a field the schema
    /// requires, which the TypeScript and Python validators reject, so the
    /// property opts out of the context-wide omission and is always written.
    /// Every other valueless property must still disappear.
    /// </summary>
    private static readonly HashSet<string> RequiredNullsThatMustBeWritten = new()
    {
        "CustomEvent/value",
    };

    [Fact]
    public void EveryWireTypeOmitsPropertiesWithoutAValue()
    {
        var wireTypes = NullOmissionProbe.DiscoverWireTypes();
        Assert.True(wireTypes.Count > 30, $"reflection found only {wireTypes.Count} wire types");

        var offenders = new List<string>();

        foreach (var type in wireTypes)
        {
            var probe = NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(
                probe,
                AGUIJsonSerializerContext.Default.GetTypeInfo(type)!);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                var offender = $"{type.Name}{path}";
                if (!RequiredNullsThatMustBeWritten.Contains(offender))
                {
                    offenders.Add(offender);
                }
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryEventOmitsPropertiesWithoutAValueWhenWrittenAsBaseEvent()
    {
        // The producer path (SSE formatter, HTTP transport) always writes through the
        // BaseEvent type info, which dispatches via BaseEventJsonConverter. Cover that
        // route separately from serializing each concrete type directly.
        var eventTypes = NullOmissionProbe.DiscoverWireTypes()
            .Where(type => typeof(BaseEvent).IsAssignableFrom(type))
            .ToList();
        Assert.True(eventTypes.Count > 20, $"reflection found only {eventTypes.Count} event types");

        var offenders = new List<string>();

        foreach (var type in eventTypes)
        {
            var probe = (BaseEvent)NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, AGUIJsonSerializerContext.Default.BaseEvent);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                var offender = $"{type.Name}{path}";
                if (!RequiredNullsThatMustBeWritten.Contains(offender))
                {
                    offenders.Add(offender);
                }
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryWireTypeOmitsPropertiesWithoutAValueThroughCallerOwnedOptions()
    {
        // Same sweep, resolved the way a host application composes AG-UI types into its own
        // JsonSerializerOptions.
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var offenders = new List<string>();

        foreach (var type in NullOmissionProbe.DiscoverWireTypes())
        {
            var probe = NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, type, callerOwned);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                var offender = $"{type.Name}{path}";
                if (!RequiredNullsThatMustBeWritten.Contains(offender))
                {
                    offenders.Add(offender);
                }
            }
        }

        Assert.Empty(offenders);
    }

    /// <summary>
    /// Host-owned options holding only the bare source-generated context: what Microsoft
    /// Agent Framework's <c>ConfigureAGUIJsonOptions</c> builds, and what ASP.NET's SSE result
    /// then serializes every event through. No <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/>,
    /// no <c>DefaultIgnoreCondition</c> of its own.
    /// </summary>
    internal static JsonSerializerOptions HostOptionsWithTheBareContext()
    {
        var options = new JsonSerializerOptions();
        options.TypeInfoResolverChain.Insert(0, AGUIJsonSerializerContext.Default);
        return options;
    }

    [Fact]
    public void EveryWireTypeOmitsPropertiesWithoutAValueThroughHostOptionsWithTheBareContext()
    {
        var host = HostOptionsWithTheBareContext();
        var offenders = new List<string>();
        var requiredNullsSeen = new HashSet<string>();

        foreach (var type in NullOmissionProbe.DiscoverWireTypes())
        {
            var probe = NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, type, host);

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                var offender = $"{type.Name}{path}";
                if (RequiredNullsThatMustBeWritten.Contains(offender))
                {
                    requiredNullsSeen.Add(offender);
                }
                else
                {
                    offenders.Add(offender);
                }
            }
        }

        Assert.Empty(offenders);

        // The control: the sweep does see a null when one is written. CUSTOM.value is left
        // unset by the probe (it is nullable) and must still come out as "value": null.
        Assert.Equal(RequiredNullsThatMustBeWritten, requiredNullsSeen);
    }

    [Fact]
    public void EveryEventOmitsPropertiesWithoutAValueWhenWrittenAsBaseEventThroughHostOptionsWithTheBareContext()
    {
        // The SSE path writes each event as BaseEvent, which dispatches via BaseEventJsonConverter
        // to the concrete type info resolved from the host's options.
        var host = HostOptionsWithTheBareContext();
        var offenders = new List<string>();

        foreach (var type in NullOmissionProbe.DiscoverWireTypes().Where(type => typeof(BaseEvent).IsAssignableFrom(type)))
        {
            var probe = (BaseEvent)NullOmissionProbe.Create(type);
            var json = JsonSerializer.Serialize(probe, host.GetTypeInfo(typeof(BaseEvent)));

            using var document = JsonDocument.Parse(json);
            foreach (var path in NullOmissionProbe.FindNullPaths(document.RootElement))
            {
                var offender = $"{type.Name}{path}";
                if (!RequiredNullsThatMustBeWritten.Contains(offender))
                {
                    offenders.Add(offender);
                }
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void OmissionSurvivesCallerOwnedSerializerOptions()
    {
        // Composing AG-UI types into caller-owned options means inserting a resolver, not
        // copying the context's options — DefaultIgnoreCondition does not travel that way.
        // AGUIJsonUtilities.DefaultTypeInfoResolver is what carries the rule across, and
        // AGUIChatClient uses it for exactly this reason.
        var callerOwned = new JsonSerializerOptions
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var json = JsonSerializer.Serialize<BaseEvent>(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            callerOwned);

        Assert.DoesNotContain("parentMessageId", json, StringComparison.Ordinal);
    }

    [Fact]
    public void HostOptionsWithTheBareContextKeepNullsThatAreValues()
    {
        var host = HostOptionsWithTheBareContext();
        static JsonElement Parse(string json) => JsonSerializer.Deserialize<JsonElement>(json);

        // A null inside state, a JSON Patch "add" of null, a whole-null snapshot and RAW payload.
        Assert.Equal(
            """{"type":"STATE_SNAPSHOT","snapshot":{"selectedId":null,"items":[null,1]}}""",
            JsonSerializer.Serialize<BaseEvent>(
                new StateSnapshotEvent { Snapshot = Parse("""{"selectedId":null,"items":[null,1]}""") }, host));
        Assert.Equal(
            """{"type":"STATE_SNAPSHOT","snapshot":null}""",
            JsonSerializer.Serialize<BaseEvent>(new StateSnapshotEvent { Snapshot = Parse("null") }, host));
        Assert.Equal(
            """{"type":"STATE_DELTA","delta":[{"op":"add","path":"/selectedId","value":null}]}""",
            JsonSerializer.Serialize<BaseEvent>(
                new StateDeltaEvent { Delta = Parse("""[{"op":"add","path":"/selectedId","value":null}]""") }, host));
        Assert.Equal(
            """{"type":"RAW","event":null}""",
            JsonSerializer.Serialize<BaseEvent>(new RawEvent { Event = Parse("null") }, host));

        // CUSTOM.value is required and null is a legal value, whether the model holds JSON null
        // or nothing at all; nulls inside it are values too.
        Assert.Equal(
            """{"type":"CUSTOM","name":"ping","value":null}""",
            JsonSerializer.Serialize<BaseEvent>(new CustomEvent { Name = "ping", Value = Parse("null") }, host));
        Assert.Equal(
            """{"type":"CUSTOM","name":"ping","value":null}""",
            JsonSerializer.Serialize<BaseEvent>(new CustomEvent { Name = "ping" }, host));
        Assert.Equal(
            """{"type":"CUSTOM","name":"ping","value":{"latencyMs":null}}""",
            JsonSerializer.Serialize<BaseEvent>(new CustomEvent { Name = "ping", Value = Parse("""{"latencyMs":null}""") }, host));

        // Null under a metadata key, and inside the state a run starts from.
        using var finished = JsonDocument.Parse(JsonSerializer.Serialize<BaseEvent>(
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1", Metadata = Parse("""{"retained":null}""") }, host));
        Assert.Equal(JsonValueKind.Null, finished.RootElement.GetProperty("metadata").GetProperty("retained").ValueKind);
        Assert.Equal(["/metadata/retained"], NullOmissionProbe.FindNullPaths(finished.RootElement));

        var input = JsonSerializer.Serialize(
            new RunAgentInput { ThreadId = "t1", RunId = "r1", State = Parse("""{"cursor":null}""") },
            host);
        Assert.Contains("\"state\":{\"cursor\":null}", input, StringComparison.Ordinal);
        Assert.DoesNotContain("parentRunId", input, StringComparison.Ordinal);
    }

    [Fact]
    public void CallerOwnedOptionsKeepNullsThatAreValues()
    {
        var callerOwned = new JsonSerializerOptions();
        callerOwned.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);

        var snapshot = JsonSerializer.Deserialize<JsonElement>("""{"selectedId":null}""");
        var json = JsonSerializer.Serialize<BaseEvent>(
            new StateSnapshotEvent { Snapshot = snapshot },
            callerOwned);

        Assert.Contains("\"selectedId\":null", json, StringComparison.Ordinal);
    }

    [Fact]
    public void ToolCallStartOmitsParentMessageIdWhenItHasNoValue()
    {
        // The specific null that broke TypeScript clients on the first tool call.
        var json = JsonSerializer.Serialize(
            new ToolCallStartEvent { ToolCallId = "tc_1", ToolCallName = "search" },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.DoesNotContain("parentMessageId", json, StringComparison.Ordinal);
    }

    [Fact]
    public void RunFinishedOmitsOutcomeWhenItHasNoValue()
    {
        var json = JsonSerializer.Serialize(
            new RunFinishedEvent { ThreadId = "thread_1", RunId = "run_1" },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.DoesNotContain("outcome", json, StringComparison.Ordinal);
    }

    [Fact]
    public void NullsInsideAnOpaquePayloadAreValuesAndSurvive()
    {
        // Omission is about fields with no value, not about null as a value.
        var snapshot = JsonSerializer.Deserialize<JsonElement>(
            """{"selectedId":null,"items":[null,1]}""");

        var json = JsonSerializer.Serialize(
            new StateSnapshotEvent { Snapshot = snapshot },
            AGUIJsonSerializerContext.Default.BaseEvent);

        Assert.Contains("\"selectedId\":null", json, StringComparison.Ordinal);
        Assert.Contains("[null,1]", json, StringComparison.Ordinal);
    }
}

/// <summary>
/// Builds "has no value" probes: every property the contract requires is filled in, every
/// optional property is left unset. What reaches the JSON is then exactly the question this
/// test file asks.
/// </summary>
internal static class NullOmissionProbe
{
    private static readonly NullabilityInfoContext NullabilityContext = new();

    /// <summary>
    /// Every public, concrete, parameterless-constructible type in AGUI.Abstractions that
    /// <see cref="AGUIJsonSerializerContext"/> knows how to write — that is, the AG-UI wire
    /// surface, discovered rather than listed.
    /// </summary>
    internal static IReadOnlyList<Type> DiscoverWireTypes()
    {
        return typeof(BaseEvent).Assembly
            .GetExportedTypes()
            .Where(type =>
                type is { IsClass: true, IsAbstract: false, IsGenericTypeDefinition: false } &&
                type.GetConstructor(Type.EmptyTypes) is not null &&
                AGUIJsonSerializerContext.Default.GetTypeInfo(type) is not null)
            .OrderBy(type => type.FullName, StringComparer.Ordinal)
            .ToList();
    }

    internal static object Create(Type type)
    {
        var instance = Activator.CreateInstance(type)
            ?? throw new InvalidOperationException($"Could not construct {type.Name}.");

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.SetMethod is null || !property.SetMethod.IsPublic)
            {
                continue;
            }

            if (IsOptional(property))
            {
                // The point of the probe: leave it unset and see whether it reaches the wire.
                continue;
            }

            var value = SampleFor(property.PropertyType);
            if (value is not null)
            {
                property.SetValue(instance, value);
            }
        }

        return instance;
    }

    /// <summary>
    /// Collects the paths of every JSON <c>null</c> under <paramref name="element"/>.
    /// </summary>
    internal static IReadOnlyList<string> FindNullPaths(JsonElement element, string path = "")
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Null:
                return [path.Length == 0 ? "/" : path];

            case JsonValueKind.Object:
                var fromObject = new List<string>();
                foreach (var property in element.EnumerateObject())
                {
                    fromObject.AddRange(FindNullPaths(property.Value, $"{path}/{property.Name}"));
                }

                return fromObject;

            case JsonValueKind.Array:
                var fromArray = new List<string>();
                var index = 0;
                foreach (var item in element.EnumerateArray())
                {
                    fromArray.AddRange(FindNullPaths(item, $"{path}/{index}"));
                    index++;
                }

                return fromArray;

            default:
                return [];
        }
    }

    /// <summary>
    /// A property is optional — "may have no value" — when it is a nullable reference type
    /// or a <see cref="Nullable{T}"/>. Those are the properties whose absence must not turn
    /// into a <c>null</c> on the wire.
    /// </summary>
    internal static bool IsOptional(PropertyInfo property)
    {
        if (Nullable.GetUnderlyingType(property.PropertyType) is not null)
        {
            return true;
        }

        if (property.PropertyType.IsValueType)
        {
            return false;
        }

        return NullabilityContext.Create(property).WriteState == NullabilityState.Nullable;
    }

    private static object? SampleFor(Type type)
    {
        if (type == typeof(string))
        {
            return "x";
        }

        if (type == typeof(JsonElement))
        {
            return JsonSerializer.Deserialize<JsonElement>("{}");
        }

        if (type.IsValueType)
        {
            return null; // Already a usable default (0, false, empty JsonElement).
        }

        if (typeof(IEnumerable).IsAssignableFrom(type))
        {
            return null; // Collection properties on wire types initialize themselves to empty.
        }

        if (type.IsAbstract)
        {
            // A required union-typed property (a media part's source, say): fill it with the
            // first concrete member, so the probe stays "every required property set".
            var member = type.Assembly.GetExportedTypes()
                .Where(candidate => candidate is { IsClass: true, IsAbstract: false } &&
                    type.IsAssignableFrom(candidate) &&
                    candidate.GetConstructor(Type.EmptyTypes) is not null)
                .OrderBy(candidate => candidate.FullName, StringComparer.Ordinal)
                .FirstOrDefault();
            return member is null ? null : Create(member);
        }

        return type.GetConstructor(Type.EmptyTypes) is null ? null : Create(type);
    }
}
