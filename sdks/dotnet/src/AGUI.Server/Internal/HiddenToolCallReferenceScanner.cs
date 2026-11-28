using System;
using System.Collections.Generic;
using System.Text.Json;

namespace AGUI.Server;

// Walks an opaque JSON payload (an event's rawEvent, or a RAW event's body) looking for any trace of
// a hidden tool call: a string equal to a hidden call ID, or an object naming a hidden tool. The
// converter attaches the whole serialized ChatResponseUpdate as rawEvent, and one update can carry
// text next to a function call or result, so a text event can otherwise smuggle a hidden call's
// arguments or result past the filter. Calls discovered here are added to the hidden ID set so
// their later events and results are caught too, so the whole payload is scanned even after a match.
// JSON nested inside string values is not parsed.
internal static class HiddenToolCallReferenceScanner
{
    public static bool References(
        JsonElement payload,
        Func<string, bool> isHiddenToolName,
        bool matchBareNames,
        HashSet<string> hiddenToolCallIds)
    {
        var pending = new Stack<JsonElement>();
        pending.Push(payload);
        var found = false;

        while (pending.Count > 0)
        {
            var current = pending.Pop();
            switch (current.ValueKind)
            {
                case JsonValueKind.String:
                    found |= hiddenToolCallIds.Contains(current.GetString()!);
                    break;

                case JsonValueKind.Array:
                    foreach (var item in current.EnumerateArray())
                    {
                        pending.Push(item);
                    }

                    break;

                case JsonValueKind.Object:
                    found |= ObjectReferences(current, isHiddenToolName, matchBareNames, hiddenToolCallIds, pending);
                    break;
            }
        }

        return found;
    }

    private static bool ObjectReferences(
        JsonElement obj,
        Func<string, bool> isHiddenToolName,
        bool matchBareNames,
        HashSet<string> hiddenToolCallIds,
        Stack<JsonElement> pending)
    {
        string? toolName = null;
        string? bareName = null;
        string? callId = null;
        string? genericId = null;
        string? nestedFunctionName = null;
        var hasCallPayload = false;
        var found = false;

        foreach (var property in obj.EnumerateObject())
        {
            var value = property.Value;
            if (NameMatches(property.Name, "arguments") || NameMatches(property.Name, "input"))
            {
                hasCallPayload = true;
            }

            if (value.ValueKind != JsonValueKind.String)
            {
                // The provider-native shape nests the name: {"id":..,"function":{"name":..}}.
                if (NameMatches(property.Name, "function")
                    && value.ValueKind == JsonValueKind.Object
                    && TryGetName(value) is { } functionName)
                {
                    nestedFunctionName = functionName;
                }

                if (value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    pending.Push(value);
                }

                continue;
            }

            var text = value.GetString()!;
            found |= hiddenToolCallIds.Contains(text);

            if (NameMatches(property.Name, "toolCallName") || NameMatches(property.Name, "functionName"))
            {
                toolName = text;
            }
            else if (NameMatches(property.Name, "name"))
            {
                bareName = text;
            }
            else if (NameMatches(property.Name, "callId") || NameMatches(property.Name, "toolCallId"))
            {
                callId = text;
            }
            else if (NameMatches(property.Name, "id"))
            {
                genericId = text;
            }
        }

        // A bare "name" only identifies a tool when a call ID sits beside it (Microsoft.Extensions.AI's
        // FunctionCallContent shape), unless the caller listed the hidden names explicitly, in which
        // case any match is worth scrubbing.
        // A generic "id" only identifies a call when the object also carries the call's payload
        // (OpenAI's {"id","function":{..}}, Anthropic's {"id","name","input"}).
        if (callId is null && genericId is not null && (nestedFunctionName is not null || hasCallPayload))
        {
            callId = genericId;
        }

        if (toolName is null && nestedFunctionName is not null && callId is not null)
        {
            toolName = nestedFunctionName;
        }

        if (toolName is null && bareName is not null && (callId is not null || matchBareNames))
        {
            toolName = bareName;
        }

        if (toolName is null || !isHiddenToolName(toolName))
        {
            return found;
        }

        if (callId is not null)
        {
            hiddenToolCallIds.Add(callId);
        }

        // Provider items carry their own ID next to the call ID (OpenAI Responses: "id":"fc_..",
        // "call_id":"call_.."), and their argument deltas reference the item ID.
        if (genericId is not null)
        {
            hiddenToolCallIds.Add(genericId);
        }

        return true;
    }

    private static string? TryGetName(JsonElement obj)
    {
        foreach (var property in obj.EnumerateObject())
        {
            if (NameMatches(property.Name, "name") && property.Value.ValueKind == JsonValueKind.String)
            {
                return property.Value.GetString();
            }
        }

        return null;
    }

    // The payload was written with the host's naming policy, so "callId", "CallId", "call_id" and
    // "call-id" all name the same property.
    private static bool NameMatches(string propertyName, string camelCaseName)
    {
        var j = 0;
        foreach (var c in propertyName)
        {
            if (c is '_' or '-')
            {
                continue;
            }

            if (j >= camelCaseName.Length || char.ToLowerInvariant(c) != char.ToLowerInvariant(camelCaseName[j]))
            {
                return false;
            }

            j++;
        }

        return j == camelCaseName.Length;
    }
}
