using Microsoft.Extensions.AI;

namespace AGUI.A2UI;

internal static class A2UIHistoryNormalizer
{
    // The render subagent's calls are streamed for UI replay, so native history can contain
    // several assistant call messages before the enclosing generate result. Present that
    // completed block as one tool batch to providers; never change the persisted envelopes.
    internal static List<ChatMessage> Normalize(IEnumerable<ChatMessage> messages, string generateName)
    {
        List<ChatMessage> source = messages.ToList();
        List<ChatMessage> output = [];
        for (int start = 0; start < source.Count; start++)
        {
            ChatMessage first = source[start];
            if (first.Role != ChatRole.Assistant || !first.Contents.OfType<FunctionCallContent>().Any(c => c.Name == generateName))
            {
                output.Add(first);
                continue;
            }

            List<ChatMessage> calls = [first];
            List<ChatMessage> results = [];
            HashSet<string> pending = first.Contents.OfType<FunctionCallContent>().Select(c => c.CallId).ToHashSet(StringComparer.Ordinal);
            HashSet<string> seen = new(pending, StringComparer.Ordinal);
            int end = start;
            bool valid = pending.Count == first.Contents.OfType<FunctionCallContent>().Count();
            while (valid && pending.Count > 0 && ++end < source.Count)
            {
                ChatMessage next = source[end];
                if (next.Role == ChatRole.Assistant && next.Contents.Count > 0 && next.Contents.All(c => c is FunctionCallContent { Name: A2UIConstants.RenderA2UIToolName }))
                {
                    foreach (FunctionCallContent call in next.Contents.Cast<FunctionCallContent>())
                    {
                        valid &= seen.Add(call.CallId);
                        pending.Add(call.CallId);
                    }
                    calls.Add(next);
                }
                else if (next.Role == ChatRole.Tool && next.Contents.Count > 0 && next.Contents.All(c => c is FunctionResultContent))
                {
                    foreach (FunctionResultContent result in next.Contents.Cast<FunctionResultContent>())
                    {
                        valid &= pending.Remove(result.CallId);
                    }
                    results.Add(next);
                }
                else { valid = false; }
            }

            if (valid && pending.Count == 0 && calls.Count > 1)
            {
                ChatMessage batch = first.Clone();
                batch.Contents = calls.SelectMany(m => m.Contents).ToList();
                output.Add(batch);
                output.AddRange(results);
                start = end;
            }
            else { output.Add(first); }
        }
        return output;
    }
}
