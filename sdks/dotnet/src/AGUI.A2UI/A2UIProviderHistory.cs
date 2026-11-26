using System.Text.Json;
using Microsoft.Extensions.AI;

namespace AGUI.A2UI;

// The native transcript records nested execution order: generator call, renderer
// calls/results, generator result. Providers require the generator's result before
// another assistant message. Project complete, explicitly owned blocks at the model
// boundary only; never rewrite the persisted transcript or the streamed events.
internal static class A2UIProviderHistory
{
    internal static List<ChatMessage> Project(IEnumerable<ChatMessage> messages, string generatorName)
    {
        var history = messages.ToList();
        var projected = new List<ChatMessage>();
        for (int start = 0; start < history.Count; start++)
        {
            ChatMessage parent = history[start];
            var roots = parent.Contents.OfType<FunctionCallContent>().ToList();
            if (parent.Role != ChatRole.Assistant || roots.Count == 0 || roots.Any(c => c.Name != generatorName) ||
                roots.Select(c => c.CallId).Distinct(StringComparer.Ordinal).Count() != roots.Count ||
                !TryFindBlock(history, start, roots, out int end))
            {
                projected.Add(parent);
                continue;
            }

            var rootIds = roots.Select(c => c.CallId).ToHashSet(StringComparer.Ordinal);
            projected.Add(parent);
            // Split combined child + parent tool messages using shallow clones. The
            // canonical content objects (including metadata and result payloads) survive.
            for (int i = start + 1; i <= end; i++)
            {
                var results = history[i].Contents.Where(c => c is FunctionResultContent r && rootIds.Contains(r.CallId)).ToList();
                if (results.Count > 0)
                {
                    ChatMessage copy = history[i].Clone();
                    copy.Contents = results;
                    projected.Add(copy);
                }
            }
            for (int i = start + 1; i <= end; i++)
            {
                ChatMessage message = history[i];
                var contents = message.Contents.Where(c => c is not FunctionResultContent r || !rootIds.Contains(r.CallId)).ToList();
                if (contents.Count == message.Contents.Count)
                {
                    projected.Add(message);
                }
                else if (contents.Count > 0)
                {
                    ChatMessage copy = message.Clone();
                    copy.Contents = contents;
                    projected.Add(copy);
                }
            }
            start = end;
        }
        return projected;
    }

    private static bool TryFindBlock(List<ChatMessage> history, int start, List<FunctionCallContent> roots, out int end)
    {
        end = start;
        var rootIds = roots.Select(c => c.CallId).ToHashSet(StringComparer.Ordinal);
        var calls = new HashSet<string>(rootIds, StringComparer.Ordinal);
        var pending = new HashSet<string>(rootIds, StringComparer.Ordinal);
        bool hasChild = false;
        for (int i = start + 1; i < history.Count; i++)
        {
            ChatMessage message = history[i];
            if ((message.Role != ChatRole.Assistant && message.Role != ChatRole.Tool) ||
                (message.Role == ChatRole.Assistant && pending.Any(id => !rootIds.Contains(id))))
            {
                return false;
            }
            foreach (FunctionCallContent child in message.Contents.OfType<FunctionCallContent>())
            {
                if (message.Role != ChatRole.Assistant || child.Name != A2UIConstants.RenderA2UIToolName ||
                    !rootIds.Contains(ReadParent(child) ?? string.Empty) || !calls.Add(child.CallId))
                {
                    return false;
                }
                pending.Add(child.CallId);
                hasChild = true;
            }
            foreach (FunctionResultContent result in message.Contents.OfType<FunctionResultContent>())
            {
                if (message.Role != ChatRole.Tool || !pending.Remove(result.CallId))
                {
                    return false;
                }
            }
            if (pending.Count == 0)
            {
                end = i;
                return hasChild;
            }
        }
        return false;
    }

    private static string? ReadParent(FunctionCallContent call)
    {
        if (call.AdditionalProperties?.TryGetValue("ag_ui_parent_tool_call_id", out object? value) != true)
        {
            return null;
        }
        return value switch
        {
            string id => id,
            JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
            _ => null,
        };
    }
}
