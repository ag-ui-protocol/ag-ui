using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Client;

internal static class EventStreamConverter
{
    /// <summary>
    /// Converts an AG-UI event stream to <see cref="ChatResponseUpdate"/>s, stamping the
    /// ones a subagent produced with that subagent's id. An update produced by the parent —
    /// or one whose entity has no recorded owner — carries no
    /// <c>agui.subagentRunId</c> key at all.
    /// </summary>
    /// <remarks>
    /// Carried in <see cref="ChatResponseUpdate.AdditionalProperties"/> under the same key
    /// <c>AsChatMessages</c> uses, because <c>ToChatResponse</c> preserves it onto the
    /// coalesced <see cref="ChatMessage"/>. Without it only the request direction was
    /// covered: AGUIChatClient.GetResponseAsync builds its response from these updates, so
    /// a subagent's message came back untagged and the next turn sent it to the agent as
    /// the parent's.
    ///
    /// The owner map is populated by the core loop, which sees every event — including the
    /// openers that yield no update at all. Deriving it out here from updates alone missed
    /// those, so an opener-only stream (tagged START, untagged content and end) was never
    /// attributed.
    /// </remarks>
    /// <param name="events">The producer's event stream.</param>
    /// <param name="jsonSerializerOptions">Serialization options for tool-call arguments.</param>
    /// <param name="requestThreadId">
    /// The <c>threadId</c> of the input this stream answers, when the caller knows it.
    /// Every run on the stream carries the input's <c>threadId</c> on its boundary events
    /// (<c>docs/spec/draft/basic/run-input.mdx</c>, "Identity"), so a producer that names a
    /// different conversation is rejected. Null means the caller cannot say — the
    /// intra-stream agreement checks still apply.
    /// </param>
    /// <param name="cancellationToken">Cancels the enumeration.</param>
    internal static async IAsyncEnumerable<ChatResponseUpdate> AsChatResponseUpdates(
        IAsyncEnumerable<BaseEvent> events,
        JsonSerializerOptions jsonSerializerOptions,
        string? requestThreadId = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // entityId -> owner, where an entity is a messageId or a toolCallId. Owned by the
        // core loop and mutated as it validates, so it is reset with the rest of the
        // per-run state on a new RUN_STARTED.
        var owners = new Dictionary<string, string?>(StringComparer.Ordinal);

        await foreach (var update in AsChatResponseUpdatesCore(
                events, jsonSerializerOptions, owners, requestThreadId, cancellationToken)
            .ConfigureAwait(false))
        {
            // The marker means this update was buffered and its owner already frozen at
            // creation — including when that owner is the parent. Re-resolving would read a
            // map that has moved on since.
            var alreadyResolved =
                update.AdditionalProperties?.Remove(AGUIOwnerResolvedKey) == true;
            if (!alreadyResolved && ResolveOwner(update, owners) is { } resolved)
            {
                update.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                update.AdditionalProperties[AGUISubagentRunIdKey] = resolved;
            }

            yield return update;
        }
    }

    /// <summary>
    /// Key matching <c>AGUIChatMessageExtensions</c>, so an update's attribution survives
    /// into <see cref="ChatMessage.AdditionalProperties"/> and back out through
    /// <c>AsAGUIMessages</c> on the next turn.
    /// </summary>
    internal const string AGUISubagentRunIdKey = "agui.subagentRunId";

    /// <summary>
    /// Transient marker saying an update's owner was already determined at creation, so the
    /// wrapper must not re-resolve it. Needed as its own flag because "resolved to the
    /// parent" carries no subagentRunId and would otherwise be indistinguishable from
    /// "unresolved". Removed before the update is yielded.
    /// </summary>
    private const string AGUIOwnerResolvedKey = "agui.__ownerResolved";

    /// <summary>
    /// Renders the open steps for an error message, naming each step's owner. Steps are
    /// keyed by owner + name, so the raw keys are not readable on their own.
    /// </summary>
    private static string DescribeSteps(HashSet<(string? Owner, string Name)> steps)
    {
        var parts = new List<string>();
        foreach (var s in steps)
        {
            parts.Add(s.Owner is null ? s.Name : $"{s.Name} (subagent '{s.Owner}')");
        }

        return string.Join(", ", parts);
    }

    /// <summary>
    /// Owner for an update, tried from the most specific identity to the least: the
    /// entity id of the event that produced it (which knows whether it lives in the
    /// message or the tool-call namespace); then its MessageId; then the call id of any
    /// function call or result it carries. The event key must come before MessageId:
    /// updates carry a MessageId for the coalescer's sake, and with the SDK-default
    /// MessageId == ToolCallId result shape, reading the message namespace first handed
    /// a tool CALL's update the result MESSAGE's owner.
    /// </summary>
    private static string? ResolveOwner(ChatResponseUpdate update, Dictionary<string, string?> owners)
    {
        if (update.RawRepresentation is BaseEvent evt)
        {
            foreach (var entityKey in AttributedEntityKeys(evt))
            {
                if (owners.TryGetValue(entityKey, out var byEntity))
                {
                    return byEntity;
                }
            }
        }

        if (update.MessageId is not null
            && owners.TryGetValue(MessageKey(update.MessageId), out var byMessage))
        {
            return byMessage;
        }

        foreach (var content in update.Contents)
        {
            var callId = content switch
            {
                FunctionCallContent call => call.CallId,
                FunctionResultContent result => result.CallId,
                _ => null,
            };

            if (callId is not null && owners.TryGetValue(CallKey(callId), out var byCall))
            {
                return byCall;
            }
        }

        return null;
    }

    /// <summary>
    /// Message-id key space for the owner map. Message ids and tool call ids are separate
    /// namespaces that can legitimately collide — this SDK's own server helper emits
    /// TOOL_CALL_RESULT with <c>MessageId == ToolCallId</c> — so a single flat map let a
    /// result's owner overwrite its call's, and the still-buffered FunctionCallContent
    /// flushed with the wrong one.
    /// </summary>
    private static string MessageKey(string id) => "msg:" + id;

    /// <summary>Tool-call-id key space for the owner map. See <see cref="MessageKey"/>.</summary>
    private static string CallKey(string id) => "call:" + id;

    /// <summary>The namespaced entity keys an event refers to, most specific first.</summary>
    private static IEnumerable<string> AttributedEntityKeys(BaseEvent evt)
    {
        switch (evt)
        {
            case TextMessageStartEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case TextMessageContentEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case TextMessageEndEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ReasoningStartEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ReasoningMessageStartEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ReasoningMessageContentEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ReasoningMessageEndEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ReasoningMessageChunkEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            // `subtype` selects the namespace: a "tool-call" value's entityId is a tool call
            // id, not a message id. The validation path already made this distinction; the
            // resolution path did not, so with the SDK-default MessageId == ToolCallId shape
            // it read the RESULT message's owner instead of the call's.
            case ReasoningEncryptedValueEvent e:
                if (e.EntityId is not null)
                {
                    yield return e.Subtype == "tool-call" ? CallKey(e.EntityId) : MessageKey(e.EntityId);
                }

                break;
            case ActivitySnapshotEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            case ActivityDeltaEvent e: if (e.MessageId is not null) yield return MessageKey(e.MessageId); break;
            // The minted tool message first: that is what this update represents. The call
            // key is a fallback for consumers that only see the call.
            case ToolCallResultEvent e:
                if (e.MessageId is not null) yield return MessageKey(e.MessageId);
                if (e.ToolCallId is not null) yield return CallKey(e.ToolCallId);
                break;
            case ToolCallStartEvent e: if (e.ToolCallId is not null) yield return CallKey(e.ToolCallId); break;
            case ToolCallArgsEvent e: if (e.ToolCallId is not null) yield return CallKey(e.ToolCallId); break;
            case ToolCallEndEvent e: if (e.ToolCallId is not null) yield return CallKey(e.ToolCallId); break;
        }
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> AsChatResponseUpdatesCore(
        IAsyncEnumerable<BaseEvent> events,
        JsonSerializerOptions jsonSerializerOptions,
        Dictionary<string, string?> owners,
        string? requestThreadId,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string? conversationId = null;
        string? responseId = null;
        var textMessageBuilder = new TextMessageBuilder();
        var toolCallBuilder = new ToolCallBuilder();

        // Event verification state
        // Steps are keyed by OWNER + name, not name alone. A step name is only unique
        // within one agent: a subagent runs the same graph shape as its parent, so both
        // legitimately have a step called "tools" open at once. Keying by name alone
        // rejected that valid nesting while ACCEPTING a STEP_FINISHED that closed the
        // parent's step under a subagent's tag -- the shape a design partner reported
        // from a real run. Mirrors the TypeScript verifier.
        var activeSteps = new HashSet<(string? Owner, string Name)>();
        // Subagents open right now, mapped to the parent that spawned them (null for one
        // the parent run started directly). Nesting is tracked by this identity link, not
        // by the order events arrive in, so interleaved parallel subagents cannot swap
        // parents.
        var activeSubagents = new Dictionary<string, string?>();
        // Ids closed by a terminal in this run. Needed because "no duplicate
        // SUBAGENT_STARTED for the same id" holds for the whole run — a subagentRunId is a
        // unique handle for ONE invocation — so tracking only the active set would make
        // STARTED(s1)/FINISHED(s1)/STARTED(s1) legal. Deliberately NOT used to reject
        // later events tagged with a closed id: requiring a tag to name a still-live
        // subagent was explicitly rejected in the design so attribution-only producers
        // stay valid, and TypeScript accepts those streams too. Cleared per run.
        var closedSubagents = new HashSet<string>(StringComparer.Ordinal);
        // Owner of each open message / tool call, so a continuation tagged with a
        // different subagent is rejected here exactly as verifyEvents rejects it in
        // TypeScript. Without this the two SDKs disagreed about the same stream.
        var messageOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        var toolCallOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        // Activities are opened by ACTIVITY_SNAPSHOT and continued by ACTIVITY_DELTA on
        // the same messageId, so they need the same owner tracking. TypeScript checks
        // these; without it .NET accepted a stream TypeScript rejects.
        var activityOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        // Reasoning, tracked like the others so .NET rejects the same continuation
        // mismatches TypeScript does.
        var reasoningOwners = new Dictionary<string, string?>(StringComparer.Ordinal);
        // Id of the compact reasoning stream currently open, so a continuation chunk that
        // omits messageId can still be checked against its opener — tracked PER LANE, one
        // cursor for the parent plus one per subagent. A single cursor for the whole run
        // pointed at whichever stream opened LAST, so two subagents interleaving compact
        // reasoning had their id-less continuations checked against each other's stream and
        // rejected, while the TypeScript chunk transform resolves the lane from the tag
        // first and accepts. Dictionary keys cannot be null, hence the parent's own field.
        string? parentReasoningChunkId = null;
        var subagentReasoningChunkIds = new Dictionary<string, string>(StringComparer.Ordinal);
        // Reasoning bracketing, tracked exactly as verifyEvents tracks it: a reasoning
        // message and the span around it are separate entities that may legitimately share
        // an id (the canonical REASONING_START / REASONING_MESSAGE_START pair), so one set
        // for both would reject the ordinary shape. A continuation must name something OPEN
        // — the reducer is not left to invent a message for an orphaned fragment, nor to
        // append to one that has closed — and a run may not finish over an unclosed one.
        var activeReasoningMessages = new HashSet<string>(StringComparer.Ordinal);
        var activeReasoningSpans = new HashSet<string>(StringComparer.Ordinal);

        // READS the owner map as it stands right now and writes the answer onto the update.
        // Buffered updates are flushed after later events have mutated the map, so resolving
        // at yield time would stamp them with whoever owns the entity by then. Reading here
        // freezes the owner as of creation; the wrapper leaves an already stamped update
        // alone.
        static ChatResponseUpdate StampOwner(ChatResponseUpdate update, Dictionary<string, string?> map)
        {
            update.AdditionalProperties ??= new AdditionalPropertiesDictionary();
            // The marker goes on even when the owner is the PARENT (null). "Resolved to the
            // parent" and "not yet resolved" are different states, and conflating them let
            // the wrapper re-resolve a parent-owned buffered update after the entity had
            // been re-owned by a subagent — emitting the parent's snapshot as that
            // subagent's. Stripped again in the wrapper so it never reaches the wire.
            update.AdditionalProperties[AGUIOwnerResolvedKey] = true;
            if (ResolveOwner(update, map) is { } owner)
            {
                update.AdditionalProperties[AGUISubagentRunIdKey] = owner;
            }

            return update;
        }

        // Records the owner for an entity on a CREATION event, for the RESOLUTION map the
        // wrapper stamps updates from. Creation events carry attribution explicitly ("a
        // creation event's subagentRunId transfers to the message it mints"), so an untagged
        // one means the parent owns it — which must overwrite any stale entry, or an
        // untagged TOOL_CALL_RESULT would inherit the tool call's subagent and mint a
        // wrongly-attributed tool message. Callers that accept a SECOND opener for an
        // already-known id must therefore skip this: recording unconditionally there
        // restamped the entity as parent-owned while the validation map still named the
        // first subagent, leaving the two maps contradicting each other.
        //
        // Null means the event has no such entity; an EMPTY id is a valid string the schemas
        // accept, so skipping it lost the owner and the response came back parent-owned while
        // TypeScript kept the attribution.
        void RecordMessageOwner(string? messageId, string? subagentRunId)
        {
            if (messageId is not null)
            {
                owners[MessageKey(messageId)] = subagentRunId;
            }
        }

        void RecordCallOwner(string? toolCallId, string? subagentRunId)
        {
            if (toolCallId is not null)
            {
                owners[CallKey(toolCallId)] = subagentRunId;
            }
        }

        // Ownership seeded from replayed history: MESSAGES_SNAPSHOT and the
        // RUN_STARTED input echo both put messages on the wire that later events can
        // reference, so their owners (null = the parent agent) go on record like an
        // opener's would — and each assistant message's tool calls under the message's
        // owner, since a ToolCall carries no owner field of its own. The bucket is
        // per entity KIND: a reasoning message's continuations are checked against
        // reasoningOwners, an activity's against activityOwners.
        //
        // `authoritative` distinguishes the two sources. A snapshot restates the whole
        // conversation and consumers replace the message, so its owner replaces the
        // recorded one; the RUN_STARTED input echo is plain history and seeds only ids
        // nothing else has claimed. Mirrors verifyEvents.
        void SeedOwnersFromMessages(IList<AGUIMessage>? messages, bool authoritative)
        {
            if (messages is null)
            {
                return;
            }

            foreach (var message in messages)
            {
                if (message?.Id is not { } messageId)
                {
                    continue;
                }

                var bucket = message switch
                {
                    AGUIReasoningMessage => reasoningOwners,
                    AGUIActivityMessage => activityOwners,
                    _ => messageOwners,
                };
                if (authoritative || !bucket.ContainsKey(messageId))
                {
                    bucket[messageId] = message.SubagentRunId;
                    RecordMessageOwner(messageId, message.SubagentRunId);
                }

                if (message is AGUIAssistantMessage { ToolCalls: { } seededToolCalls })
                {
                    foreach (var seededToolCall in seededToolCalls)
                    {
                        if (seededToolCall is null
                            || (!authoritative && toolCallOwners.ContainsKey(seededToolCall.Id)))
                        {
                            continue;
                        }

                        toolCallOwners[seededToolCall.Id] = message.SubagentRunId;
                        RecordCallOwner(seededToolCall.Id, message.SubagentRunId);
                    }
                }
            }
        }

        // The compact reasoning-chunk lane cursors track OPEN streams, so they close at
        // the same points the TypeScript chunk transform closes lanes: run-level events
        // and MESSAGES_SNAPSHOT close every lane; an explicit event closes its own
        // lane's; a subagent terminal closes that subagent's. A cursor kept past those
        // points made a historical stream win parent-priority or count toward
        // ambiguity after it was already over.
        void CloseChunkLane(string? lane)
        {
            if (lane is null)
            {
                parentReasoningChunkId = null;
            }
            else
            {
                subagentReasoningChunkIds.Remove(lane);
            }
        }

        void CloseAllChunkLanes()
        {
            parentReasoningChunkId = null;
            subagentReasoningChunkIds.Clear();
        }

        var runStarted = false;
        var runFinished = false;
        var runError = false;
        var firstEventReceived = false;
        // Identity of the run currently open, recorded at RUN_STARTED so its RUN_FINISHED
        // can be held to it, plus the conversation the whole stream belongs to. Every run
        // on the stream carries the input's threadId on its boundary events and a run's two
        // boundary events must agree on their runId (run-input.mdx, "Identity"), so a
        // second run that renames the conversation is a contradiction rather than a new
        // topic. RUN_ERROR carries neither id and so is checked against neither.
        string? openRunId = null;
        string? openThreadId = null;
        var streamThreadId = string.IsNullOrEmpty(requestThreadId) ? null : requestThreadId;

        await foreach (var evt in events.WithCancellation(cancellationToken).ConfigureAwait(false))
        {
            // Lane inferred for an id-less REASONING_MESSAGE_CHUNK by the validation
            // below, carried to the processing switch so the resulting update can be
            // stamped — an event with no MessageId is unresolvable through the owner
            // maps, so without this the inferred owner never reached the consumer.
            string? inferredReasoningChunkOwner = null;

            // Verify event ordering and lifecycle rules.
            //
            // RUN_ERROR does not end the STREAM, only the run: "after RUN_ERROR a producer
            // may emit only RUN_STARTED" (lifecycle.mdx), which begins a new run in the
            // same stream. Everything else after it is still rejected — this latch is what
            // stops a failed run from continuing to produce material — and the RUN_STARTED
            // arm below resets the per-run state exactly as it does after a RUN_FINISHED.
            if (runError && evt is not RunStartedEvent)
            {
                throw new System.InvalidOperationException(
                    $"Cannot send event type '{evt.Type}': The run has already errored with 'RUN_ERROR'. Only 'RUN_STARTED' may follow, beginning a new run.");
            }

            if (runFinished && evt is not RunErrorEvent && evt is not RunStartedEvent)
            {
                throw new System.InvalidOperationException(
                    $"Cannot send event type '{evt.Type}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.");
            }

            if (!firstEventReceived)
            {
                firstEventReceived = true;
                if (evt is not RunStartedEvent && evt is not RunErrorEvent)
                {
                    throw new System.InvalidOperationException("First event must be 'RUN_STARTED'.");
                }
            }
            else if (evt is RunStartedEvent)
            {
                if (runStarted && !runFinished && !runError)
                {
                    throw new System.InvalidOperationException(
                        "Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.");
                }

                if (runFinished || runError)
                {
                    textMessageBuilder.Reset();
                    toolCallBuilder.Reset();
                    activeSteps.Clear();
                    activeSubagents.Clear();
                    closedSubagents.Clear();
                    messageOwners.Clear();
                    toolCallOwners.Clear();
                    activityOwners.Clear();
                    reasoningOwners.Clear();
                    activeReasoningMessages.Clear();
                    activeReasoningSpans.Clear();
                    parentReasoningChunkId = null;
                    subagentReasoningChunkIds.Clear();
                    owners.Clear();
                    openRunId = null;
                    openThreadId = null;
                    runFinished = false;
                    runError = false;
                    runStarted = true;
                }
            }

            // Chunk-lane close points, mirroring the TypeScript chunk transform: run
            // boundaries and MESSAGES_SNAPSHOT close every lane; an explicit event
            // closes its own lane's pending chunk stream; a subagent terminal closes
            // that subagent's. Chunk events themselves and the pure pass-through
            // events (RAW, ACTIVITY_*, REASONING_ENCRYPTED_VALUE, SUBAGENT_STARTED)
            // close nothing. Runs BEFORE the validation below so the ambiguity /
            // sole-lane inference only ever sees lanes that are genuinely open.
            switch (evt)
            {
                case RunStartedEvent or RunFinishedEvent or RunErrorEvent or MessagesSnapshotEvent:
                    CloseAllChunkLanes();
                    break;
                case SubagentFinishedEvent closingTerminal:
                    CloseChunkLane(closingTerminal.SubagentRunId);
                    break;
                case SubagentErrorEvent closingErrorTerminal:
                    CloseChunkLane(closingErrorTerminal.SubagentRunId);
                    break;
                case TextMessageStartEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case TextMessageContentEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case TextMessageEndEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ToolCallStartEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ToolCallArgsEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ToolCallEndEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ToolCallResultEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case StateSnapshotEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case StateDeltaEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case CustomEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case StepStartedEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case StepFinishedEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ReasoningStartEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ReasoningMessageStartEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ReasoningMessageContentEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ReasoningMessageEndEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                case ReasoningEndEvent explicitEvt: CloseChunkLane(explicitEvt.SubagentRunId); break;
                default:
                    break;
            }

            // Subagent lifecycle and attribution rules. Kept beside the run/step rules
            // above and mirroring verifyEvents in sdks/typescript/packages/client, so the
            // same stream is accepted or rejected identically by both SDKs.
            switch (evt)
            {
                case SubagentStartedEvent started:
                    // Required by the protocol schema, which TypeScript enforces with
                    // zod. System.Text.Json has no such notion and leaves a missing
                    // string as the property initializer (string.Empty), so without
                    // this an id-less event would register an active subagent named ""
                    // and corrupt the validation state below — while the TypeScript
                    // client rejected the very same payload.
                    RequireProvided(started.SubagentRunId, "subagentRunId", AGUIEventTypes.SubagentStarted);
                    RequireProvided(started.Name, "name", AGUIEventTypes.SubagentStarted);
                    var startedId = started.SubagentRunId!;

                    if (activeSubagents.ContainsKey(startedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': subagent '{startedId}' is already active. Finish it with 'SUBAGENT_FINISHED' first.");
                    }

                    if (closedSubagents.Contains(startedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': subagent '{startedId}' has already finished in this run. Subagent IDs are per-invocation and cannot be reused.");
                    }

                    // Started, not necessarily still active — requiring the parent to be
                    // open was stricter than the protocol defines and rejected a valid
                    // lifecycle where the parent finished before its child started.
                    if (started.ParentSubagentRunId is not null
                        && !activeSubagents.ContainsKey(started.ParentSubagentRunId)
                        && !closedSubagents.Contains(started.ParentSubagentRunId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_STARTED': parentSubagentRunId '{started.ParentSubagentRunId}' has not been started in this run.");
                    }

                    activeSubagents[startedId] = started.ParentSubagentRunId;
                    break;

                case SubagentFinishedEvent finished:
                    RequireProvided(finished.SubagentRunId, "subagentRunId", AGUIEventTypes.SubagentFinished);
                    var finishedId = finished.SubagentRunId!;
                    if (!activeSubagents.Remove(finishedId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_FINISHED': no active subagent found with ID '{finishedId}'. A 'SUBAGENT_STARTED' event must be sent first.");
                    }

                    closedSubagents.Add(finishedId);
                    break;

                case SubagentErrorEvent subagentErrored:
                    RequireProvided(subagentErrored.SubagentRunId, "subagentRunId", AGUIEventTypes.SubagentError);
                    RequireProvided(subagentErrored.Message, "message", AGUIEventTypes.SubagentError);
                    var erroredId = subagentErrored.SubagentRunId!;
                    if (!activeSubagents.Remove(erroredId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'SUBAGENT_ERROR': no active subagent found with ID '{erroredId}'. A 'SUBAGENT_STARTED' event must be sent first.");
                    }

                    closedSubagents.Add(erroredId);
                    break;

                // STATE_SNAPSHOT and STATE_DELTA are attributable, and attribution on
                // them is PROVENANCE rather than ownership: it says which subagent
                // produced the update, while the state stays run-scoped and is applied
                // run-scoped. Same meaning attribution carries on the other standalone
                // events (STEP_*, CUSTOM, RAW), none of which are checked either.
                //
                // An earlier revision threw here on an attributed state event, on the
                // grounds that only the parent owns state. That was an invented rule:
                // the protocol design lists STATE_SNAPSHOT / STATE_DELTA as carrying
                // attribution, so throwing made this client stricter than the protocol
                // and would fail a conforming producer. No case here on purpose.

                case RunFinishedEvent when activeSubagents.Count > 0:
                    throw new System.InvalidOperationException(
                        $"Cannot send 'RUN_FINISHED' while subagents are still active: {string.Join(", ", activeSubagents.Keys)}");

                case MessagesSnapshotEvent snapshot:
                    // Authoritative: the snapshot restates the conversation and
                    // consumers replace each message, so its owners replace recorded
                    // ones. See SeedOwnersFromMessages.
                    SeedOwnersFromMessages(snapshot.Messages, authoritative: true);
                    break;

                case RunStartedEvent seededRunStart:
                    // The input echo carries replayed history consumers apply, so it
                    // seeds ownership like a snapshot does (non-authoritatively — it
                    // is history, not a rewrite). See SeedOwnersFromMessages.
                    SeedOwnersFromMessages(seededRunStart.Input?.Messages, authoritative: false);
                    break;

                // Attribution consistency for the ID-keyed entities, mirroring
                // verifyEvents. The FIRST opener records the owner; a continuation, a
                // close, or a second opener tagged with a different subagent is a
                // contradiction, and for tool calls it is the consequential one — args and
                // results are what travel back to the provider on the next turn.
                //
                // First writer, not last: an id closed by its END may legally be reopened,
                // and overwriting on the reopen accepted — and silently re-owned — a
                // message or call that another subagent had opened.
                case TextMessageStartEvent textStart:
                    if (!messageOwners.ContainsKey(textStart.MessageId))
                    {
                        messageOwners[textStart.MessageId] = textStart.SubagentRunId;
                        RecordMessageOwner(textStart.MessageId, textStart.SubagentRunId);
                    }
                    else
                    {
                        RejectOwnerMismatch(
                            textStart.Type, textStart.SubagentRunId, messageOwners, textStart.MessageId, "message");
                    }

                    break;

                case TextMessageContentEvent textContent:
                    RejectOwnerMismatch(
                        textContent.Type, textContent.SubagentRunId, messageOwners, textContent.MessageId, "message");
                    break;

                case TextMessageEndEvent textEnd:
                    RejectOwnerMismatch(
                        textEnd.Type, textEnd.SubagentRunId, messageOwners, textEnd.MessageId, "message");
                    break;

                case ToolCallStartEvent toolStart:
                {
                    // A tool call lives INSIDE the assistant message parentMessageId
                    // names, and ToolCall itself carries no attribution field — so a call
                    // whose explicit tag disagrees with that message's owner cannot be
                    // represented: it would be recorded in the other owner's message and
                    // the tag lost from every snapshot and round-trip. Rejected, exactly
                    // as verifyEvents rejects it. An untagged call inherits the parent
                    // message's owner (the continuation rule: absent means "whoever owns
                    // the surrounding entity").
                    var callOwner = toolStart.SubagentRunId;
                    var parentOwnerKnown = false;
                    string? inheritedParentOwner = null;
                    if (toolStart.ParentMessageId is { } parentMessageId
                        && messageOwners.TryGetValue(parentMessageId, out var parentOwner))
                    {
                        if (toolStart.SubagentRunId is { } callTag
                            && !string.Equals(callTag, parentOwner, StringComparison.Ordinal))
                        {
                            throw new System.InvalidOperationException(
                                $"Cannot send 'TOOL_CALL_START': subagentRunId '{callTag}' does not match its parent message '{parentMessageId}' owner '{parentOwner ?? "(the parent agent)"}'. A tool call belongs to the message that carries it.");
                        }

                        parentOwnerKnown = true;
                        inheritedParentOwner = parentOwner;
                        callOwner ??= parentOwner;
                    }

                    if (!toolCallOwners.ContainsKey(toolStart.ToolCallId))
                    {
                        toolCallOwners[toolStart.ToolCallId] = callOwner;
                        RecordCallOwner(toolStart.ToolCallId, callOwner);
                    }
                    else
                    {
                        RejectOwnerMismatch(
                            toolStart.Type, toolStart.SubagentRunId, toolCallOwners, toolStart.ToolCallId, "tool call");
                        // An untagged reopen's EFFECTIVE owner is the one it inherits
                        // from its parent message — comparing only the (absent) raw tag
                        // let a reopen under a different parent slip through: the call
                        // stays inside the first parent and the new call's args land
                        // there, so the new parent ends up with no call at all.
                        if (toolStart.SubagentRunId is null
                            && parentOwnerKnown
                            && toolCallOwners.TryGetValue(toolStart.ToolCallId, out var retainedOwner)
                            && !string.Equals(inheritedParentOwner, retainedOwner, StringComparison.Ordinal))
                        {
                            throw new System.InvalidOperationException(
                                $"Cannot send 'TOOL_CALL_START': tool call '{toolStart.ToolCallId}' is owned by '{retainedOwner ?? "(the parent agent)"}' but its parent message '{toolStart.ParentMessageId}' is owned by '{inheritedParentOwner ?? "(the parent agent)"}'. A tool call belongs to the message that carries it.");
                        }
                    }

                    break;
                }

                // A creation event: it both references the call and mints the tool message.
                case ToolCallResultEvent toolResult:
                    // Only the minted tool message. TOOL_CALL_RESULT carries its own
                    // attribution — the executor can differ from the caller (client-side
                    // tool execution) — so it is recorded unconditionally, and writing it
                    // onto the tool call would restamp the buffered FunctionCallContent and
                    // lose the caller's owner.
                    RecordMessageOwner(toolResult.MessageId, toolResult.SubagentRunId);
                    break;

                // Both open a reasoning entity, usually under the same id; first writer
                // records the owner. Registering only REASONING_MESSAGE_START left
                // REASONING_START(r, s1) / REASONING_END(r, s2) with nothing to compare.
                // A SECOND opener that disagrees with the first is a contradiction, not
                // something to silently ignore: the recorded owner stayed the first
                // subagent's while the minted message was restamped with the second's,
                // so this converter's own state disagreed with itself. TypeScript
                // rejects the same shape.
                case ReasoningStartEvent outerReasoningStart:
                    // Checked against the SPAN set, not a shared one: a span and the
                    // message inside it may carry the same id — that is the canonical
                    // shape — so one set for both would reject a conforming stream.
                    if (!activeReasoningSpans.Add(outerReasoningStart.MessageId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'REASONING_START' event: A reasoning span with ID '{outerReasoningStart.MessageId}' is already in progress. Complete it with 'REASONING_END' first.");
                    }

                    if (!reasoningOwners.ContainsKey(outerReasoningStart.MessageId))
                    {
                        reasoningOwners[outerReasoningStart.MessageId] = outerReasoningStart.SubagentRunId;
                        RecordMessageOwner(outerReasoningStart.MessageId, outerReasoningStart.SubagentRunId);
                    }
                    else
                    {
                        RejectOwnerMismatch(
                            outerReasoningStart.Type, outerReasoningStart.SubagentRunId, reasoningOwners,
                            outerReasoningStart.MessageId, "reasoning message");
                    }

                    break;

                case ReasoningMessageStartEvent reasoningStart:
                    if (!activeReasoningMessages.Add(reasoningStart.MessageId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'REASONING_MESSAGE_START' event: A reasoning message with ID '{reasoningStart.MessageId}' is already in progress. Complete it with 'REASONING_MESSAGE_END' first.");
                    }

                    if (!reasoningOwners.ContainsKey(reasoningStart.MessageId))
                    {
                        reasoningOwners[reasoningStart.MessageId] = reasoningStart.SubagentRunId;
                        RecordMessageOwner(reasoningStart.MessageId, reasoningStart.SubagentRunId);
                    }
                    else
                    {
                        RejectOwnerMismatch(
                            reasoningStart.Type, reasoningStart.SubagentRunId, reasoningOwners,
                            reasoningStart.MessageId, "reasoning message");
                    }

                    break;

                // The one compact stream this SDK models. Its opener establishes the owner
                // and a later chunk must not disagree, exactly as the TypeScript chunk
                // transform enforces.
                case ReasoningMessageChunkEvent reasoningChunk:
                    // Null means the chunk omits the id and so continues the open stream;
                    // an EMPTY id is a present id, since messageId is an optional
                    // z.string(). Treating empty as absent skipped both registration and
                    // the open-stream cursor, so .NET accepted a mismatch TypeScript
                    // rejects. Same distinction as RecordMessageOwner above.
                    if (reasoningChunk.MessageId is { } chunkId)
                    {
                        // The lane the cursor moves in is the one that OWNS the id: its
                        // recorded owner if the id is already known, its own tag if this
                        // chunk is what registers it. An id is the strongest signal, so it
                        // continues wherever it is already open regardless of who sends it —
                        // the same order the TypeScript transform resolves lanes in.
                        string? laneOwner;
                        if (!reasoningOwners.TryGetValue(chunkId, out laneOwner))
                        {
                            laneOwner = reasoningChunk.SubagentRunId;
                            reasoningOwners[chunkId] = laneOwner;
                            RecordMessageOwner(chunkId, laneOwner);
                        }
                        else
                        {
                            RejectOwnerMismatch(
                                reasoningChunk.Type, reasoningChunk.SubagentRunId, reasoningOwners,
                                chunkId, "reasoning message");
                        }

                        if (laneOwner is null)
                        {
                            parentReasoningChunkId = chunkId;
                        }
                        else
                        {
                            subagentReasoningChunkIds[laneOwner] = chunkId;
                        }
                    }
                    else
                    {
                        // A tag names its lane outright; an untagged chunk continues the
                        // parent's own open stream when it has one. Only that ONE lane is
                        // consulted first: measuring the continuation against the newest
                        // stream of ANY lane rejected chunks that agreed perfectly with
                        // their own.
                        //
                        // When the chunk carries neither and the parent has nothing open,
                        // the TypeScript chunk transform's rule applies (documented in
                        // subagents.mdx): the SOLE open stream is the chunk's only
                        // possible referent — an id-less chunk can never OPEN a stream —
                        // so it continues that lane and the update is attributed to it;
                        // with MORE than one open lane the chunk is ambiguous and the
                        // stream is rejected, identically to TypeScript. Accepting it
                        // left the event unattributed on a stream the other SDK refuses.
                        string? openId;
                        if (reasoningChunk.SubagentRunId is { } laneTag)
                        {
                            subagentReasoningChunkIds.TryGetValue(laneTag, out openId);
                            inferredReasoningChunkOwner = laneTag;
                        }
                        else if (parentReasoningChunkId is not null)
                        {
                            openId = parentReasoningChunkId;
                        }
                        else if (subagentReasoningChunkIds.Count == 1)
                        {
                            var soleLane = subagentReasoningChunkIds.First();
                            openId = soleLane.Value;
                            inferredReasoningChunkOwner = soleLane.Key;
                        }
                        else if (subagentReasoningChunkIds.Count > 1)
                        {
                            throw new System.InvalidOperationException(
                                $"Ambiguous REASONING_MESSAGE_CHUNK: it carries neither a messageId nor a subagentRunId, but {subagentReasoningChunkIds.Count} lanes have an open reasoning message. Attribute the chunk to the subagent it belongs to.");
                        }
                        else
                        {
                            openId = null;
                        }

                        if (openId is not null)
                        {
                            RejectOwnerMismatch(
                                reasoningChunk.Type, reasoningChunk.SubagentRunId, reasoningOwners,
                                openId, "reasoning message");
                        }
                    }

                    break;

                // A continuation or a close must name something that is OPEN, exactly as for
                // text messages and tool calls. Without it the converter was left to invent
                // a message for an orphaned fragment, or to append to one that had closed.
                case ReasoningMessageContentEvent reasoningContent:
                    RequireOpenReasoningMessage(activeReasoningMessages, reasoningContent.Type, reasoningContent.MessageId);
                    RejectOwnerMismatch(
                        reasoningContent.Type, reasoningContent.SubagentRunId, reasoningOwners,
                        reasoningContent.MessageId, "reasoning message");
                    break;

                case ReasoningMessageEndEvent reasoningEnd:
                    RequireOpenReasoningMessage(activeReasoningMessages, reasoningEnd.Type, reasoningEnd.MessageId);
                    RejectOwnerMismatch(
                        reasoningEnd.Type, reasoningEnd.SubagentRunId, reasoningOwners,
                        reasoningEnd.MessageId, "reasoning message");
                    // Only the OPEN flag is dropped. reasoningOwners is retained for the
                    // rest of the run, so a later REASONING_ENCRYPTED_VALUE naming this id
                    // still has an owner to check and an untagged reopen cannot hand the id
                    // back to the parent.
                    activeReasoningMessages.Remove(reasoningEnd.MessageId);
                    break;

                case ReasoningEndEvent outerReasoningEnd:
                    if (!activeReasoningSpans.Contains(outerReasoningEnd.MessageId))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'REASONING_END' event: No active reasoning span found with ID '{outerReasoningEnd.MessageId}'. A 'REASONING_START' event must be sent first.");
                    }

                    RejectOwnerMismatch(
                        outerReasoningEnd.Type, outerReasoningEnd.SubagentRunId, reasoningOwners,
                        outerReasoningEnd.MessageId, "reasoning message");
                    activeReasoningSpans.Remove(outerReasoningEnd.MessageId);
                    break;

                case ReasoningEncryptedValueEvent encrypted:
                    // `subtype` decides which entity this continues, and there are THREE
                    // cases, not two. "message" means a MESSAGE — which may be a text
                    // message (owner in messageOwners) or a reasoning message (owner in
                    // reasoningOwners); the canonical use is attaching the encrypted
                    // chain-of-thought to a reasoning message, so checking messageOwners
                    // alone found nothing there and accepted a foreign tag. Ids are unique
                    // per kind, so preferring the text bucket and falling back to the
                    // reasoning bucket is unambiguous. Mirrors the TypeScript verifier.
                    RejectOwnerMismatch(
                        encrypted.Type,
                        encrypted.SubagentRunId,
                        encrypted.Subtype switch
                        {
                            "tool-call" => toolCallOwners,
                            "message" => messageOwners.ContainsKey(encrypted.EntityId)
                                ? messageOwners
                                : reasoningOwners,
                            _ => reasoningOwners,
                        },
                        encrypted.EntityId,
                        encrypted.Subtype switch
                        {
                            "tool-call" => "tool call",
                            "message" => "message",
                            _ => "reasoning message",
                        });
                    break;

                case ActivitySnapshotEvent activitySnapshot:
                    // Only a replacing snapshot re-mints the activity and so re-owns it;
                    // with Replace=false the reducer leaves the existing message alone.
                    // Absent means replace: the schemas default it to true, so a null here
                    // is "replace", and treating it as false rejected valid streams that
                    // TypeScript accepts.
                    if (!activityOwners.ContainsKey(activitySnapshot.MessageId) || activitySnapshot.Replace != false)
                    {
                        activityOwners[activitySnapshot.MessageId] = activitySnapshot.SubagentRunId;
                        RecordMessageOwner(activitySnapshot.MessageId, activitySnapshot.SubagentRunId);
                    }

                    break;

                case ActivityDeltaEvent activityDelta:
                    // "A delta naming a message that does not exist, or one that is not an
                    // activity message, is skipped; the consumer SHOULD surface a warning,
                    // and MUST NOT fail the run" (activity.mdx). Skipping is already what
                    // happens — nothing here mints a message from a delta — so only the
                    // warning was missing, and a silently dropped patch looked exactly like
                    // an applied one.
                    if (!activityOwners.ContainsKey(activityDelta.MessageId))
                    {
                        Trace.TraceWarning(
                            "[ag-ui] Skipped an 'ACTIVITY_DELTA' for message '{0}': no activity message with that id exists on this run. The patch was not applied and no message was created.",
                            activityDelta.MessageId);
                        break;
                    }

                    RejectOwnerMismatch(
                        activityDelta.Type, activityDelta.SubagentRunId, activityOwners, activityDelta.MessageId, "activity");
                    break;

                case ToolCallArgsEvent toolArgs:
                    RejectOwnerMismatch(
                        toolArgs.Type, toolArgs.SubagentRunId, toolCallOwners, toolArgs.ToolCallId, "tool call");
                    break;

                case ToolCallEndEvent toolEnd:
                    RejectOwnerMismatch(
                        toolEnd.Type, toolEnd.SubagentRunId, toolCallOwners, toolEnd.ToolCallId, "tool call");
                    // Deliberately NOT removed: a REASONING_ENCRYPTED_VALUE with
                    // subtype "tool-call" may arrive after the close, and no rule requires
                    // it to precede one. Dropping the owner here made that continuation
                    // unmatchable and accepted a mismatched one. Cleared per run instead.
                    break;

                default:
                    break;
            }

            switch (evt)
            {
                case RunStartedEvent runStartedEvt:
                    // The conversation is a property of the STREAM, not of each run: every
                    // run on it carries the input's threadId (run-input.mdx, "Identity"),
                    // so the first authority wins — the request's threadId when the caller
                    // knows it, otherwise the first RUN_STARTED — and a later run that
                    // names a different one is rejected rather than quietly re-homed.
                    if (streamThreadId is null)
                    {
                        streamThreadId = runStartedEvt.ThreadId;
                    }
                    else if (!string.Equals(streamThreadId, runStartedEvt.ThreadId, StringComparison.Ordinal))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_STARTED' for thread '{runStartedEvt.ThreadId}': this stream belongs to thread '{streamThreadId}'. Every run on a stream carries the input's threadId.");
                    }

                    // The producer's own declaration, judged against the version this
                    // client speaks. Absent is a peer from before the field and is silent;
                    // newer or uninterpretable means material this client may be dropping.
                    AGUIProtocolVersion.WarnOnProducerDeclaration(runStartedEvt.ProtocolVersion);

                    openThreadId = runStartedEvt.ThreadId;
                    openRunId = runStartedEvt.RunId;
                    runStarted = true;
                    conversationId = runStartedEvt.ThreadId;
                    responseId = runStartedEvt.RunId;
                    textMessageBuilder.SetConversationAndResponseIds(conversationId, responseId);
                    toolCallBuilder.SetIds(conversationId, responseId);

                    yield return new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = runStartedEvt,
                    };
                    break;

                case RunFinishedEvent runFinishedEvt:
                    // A run's two boundary events MUST agree on their runId, and both carry
                    // the input's threadId (run-input.mdx, "Identity"). Named in full on
                    // both sides: a mismatch is usually a producer closing the wrong run,
                    // and the reader needs to see which two ids disagree.
                    if (!string.Equals(openRunId, runFinishedEvt.RunId, StringComparison.Ordinal))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' for run '{runFinishedEvt.RunId}': the run that is open is '{openRunId}'. A run's 'RUN_STARTED' and 'RUN_FINISHED' must agree on their runId.");
                    }

                    if (!string.Equals(openThreadId, runFinishedEvt.ThreadId, StringComparison.Ordinal))
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' for thread '{runFinishedEvt.ThreadId}': run '{runFinishedEvt.RunId}' was started on thread '{openThreadId}'. A run's boundary events carry the input's threadId.");
                    }

                    if (activeSteps.Count > 0)
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' while steps are still active: {DescribeSteps(activeSteps)}");
                    }

                    if (activeReasoningMessages.Count > 0)
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' while reasoning messages are still active: {string.Join(", ", activeReasoningMessages)}");
                    }

                    if (activeReasoningSpans.Count > 0)
                    {
                        throw new System.InvalidOperationException(
                            $"Cannot send 'RUN_FINISHED' while reasoning spans are still active: {string.Join(", ", activeReasoningSpans)}");
                    }

                    // Each interrupt's id MUST be unique within the run
                    // (interrupt-resume.mdx): a resume entry answers an interrupt BY id, so
                    // two interrupts sharing one leave a single entry standing in for both
                    // — the silent skip the coverage rule exists to prevent.
                    if (runFinishedEvt.Outcome is RunFinishedInterruptOutcome duplicateScan)
                    {
                        var interruptIds = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var interrupt in duplicateScan.Interrupts)
                        {
                            if (interrupt is not null && !interruptIds.Add(interrupt.Id))
                            {
                                throw new System.InvalidOperationException(
                                    $"Cannot send 'RUN_FINISHED' with two interrupts carrying the id '{interrupt.Id}'. An interrupt id is unique within the run: a resume entry answers an interrupt by it.");
                            }
                        }
                    }

                    textMessageBuilder.EnsureCompleted();
                    toolCallBuilder.EnsureCompleted();

                    runFinished = true;

                    if (runFinishedEvt.Outcome is RunFinishedInterruptOutcome interruptOutcome)
                    {
                        // Flush buffered tool calls, converting interrupted ones to ToolApprovalRequestContent
                        foreach (var toolUpdate in toolCallBuilder.FlushWithInterrupts(interruptOutcome))
                        {
                            yield return toolUpdate;
                        }

                        // Emit non-tool-call interrupts as InterruptRequestContent
                        var nonToolContents = new List<AIContent>();
                        foreach (var interrupt in interruptOutcome.Interrupts)
                        {
                            if (string.Equals(interrupt.Reason, InterruptReasons.ToolCall, System.StringComparison.OrdinalIgnoreCase)
                                && interrupt.ToolCallId is not null)
                            {
                                // Already handled by FlushWithInterrupts above
                                continue;
                            }

                            var inputRequest = new InterruptRequestContent(interrupt.Id)
                            {
                                Reason = interrupt.Reason,
                                Message = interrupt.Message,
                                ToolCallId = interrupt.ToolCallId,
                                ResponseSchema = interrupt.ResponseSchema,
                                ExpiresAt = interrupt.ExpiresAt,
                                Metadata = interrupt.Metadata,
                            };

                            nonToolContents.Add(inputRequest);
                        }

                        if (nonToolContents.Count > 0)
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                ConversationId = conversationId,
                                ResponseId = responseId,
                                Contents = nonToolContents,
                                RawRepresentation = runFinishedEvt
                            };
                        }
                    }
                    else
                    {
                        // Flush any buffered tool calls as regular FunctionCallContent
                        foreach (var toolUpdate in toolCallBuilder.FlushAsToolCalls())
                        {
                            yield return toolUpdate;
                        }

                        yield return new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            FinishReason = ChatFinishReason.Stop,
                            RawRepresentation = runFinishedEvt
                        };
                    }

                    // Surface token usage as MEAI UsageContent so callers of the IChatClient
                    // abstraction can read it via ChatResponse.Usage rather than having to
                    // inspect RawRepresentation. One update per entry, each carrying its own
                    // ModelId, so per-model attribution survives the conversion. `provider`
                    // has no MEAI equivalent and stays available on RawRepresentation.
                    if (runFinishedEvt.Usage is { Count: > 0 } usageEntries)
                    {
                        foreach (var entry in usageEntries)
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                ConversationId = conversationId,
                                ResponseId = responseId,
                                ModelId = entry.Model,
                                Contents = [new UsageContent(ToUsageDetails(entry))],
                                RawRepresentation = runFinishedEvt,
                            };
                        }
                    }

                    break;

                case RunErrorEvent errorEvent:
                    runError = true;
                    yield return new ChatResponseUpdate(ChatRole.Assistant,
                        [new ErrorContent(errorEvent.Message) { ErrorCode = errorEvent.Code }])
                    {
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = errorEvent
                    };

                    // Preserve partial usage from failed runs through the IChatClient abstraction,
                    // matching the projection used for RUN_FINISHED usage.
                    if (errorEvent.Usage is { Count: > 0 } errorUsageEntries)
                    {
                        foreach (var entry in errorUsageEntries)
                        {
                            yield return new ChatResponseUpdate
                            {
                                Role = ChatRole.Assistant,
                                ConversationId = conversationId,
                                ResponseId = responseId,
                                ModelId = entry.Model,
                                Contents = [new UsageContent(ToUsageDetails(entry))],
                                RawRepresentation = errorEvent,
                            };
                        }
                    }

                    break;

                // These four events update builder state and yield no
                // ChatResponseUpdate, so anything carried only on them — metadata
                // included — does not reach an AGUIChatClient consumer, not even
                // through RawRepresentation. That is deliberate: metadata is a
                // wire-level field in .NET, consistent with every other
                // message-level AG-UI field (see AGUIMessage.Metadata). Consumers
                // needing it read the raw event stream instead. Documented in
                // docs/concepts/metadata.mdx.
                case TextMessageStartEvent textStart:
                    textMessageBuilder.AddTextStart(textStart);
                    break;

                case TextMessageContentEvent textContent:
                {
                    var update = textMessageBuilder.EmitTextUpdate(textContent);
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                case TextMessageEndEvent textEnd:
                    textMessageBuilder.EndCurrentMessage(textEnd);
                    break;

                case StepStartedEvent stepStarted:
                    if (!activeSteps.Add((stepStarted.SubagentRunId, stepStarted.StepName)))
                    {
                        throw new System.InvalidOperationException(
                            $"Step \"{stepStarted.StepName}\" is already active for 'STEP_STARTED'"
                            + (stepStarted.SubagentRunId is null ? "." : $" in subagent '{stepStarted.SubagentRunId}'."));
                    }

                    {
                        var update = new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            RawRepresentation = stepStarted
                        };
                        if (toolCallBuilder.IsBuffering)
                        {
                            toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                        }
                        else
                        {
                            yield return update;
                        }
                    }
                    break;

                case StepFinishedEvent stepFinished:
                    if (!activeSteps.Remove((stepFinished.SubagentRunId, stepFinished.StepName)))
                    {
                        // A step of this name IS open, but under a different owner. Called
                        // out separately because it is a far likelier mistake than a step
                        // that was never started: a producer stamping attribution from
                        // "whichever subagent is active" closes the parent's step tagged
                        // and the subagent's step untagged. The generic message sent the
                        // reader hunting for a STEP_STARTED that is in fact right there.
                        foreach (var open in activeSteps)
                        {
                            if (open.Name != stepFinished.StepName) continue;
                            var attributed = stepFinished.SubagentRunId is null
                                ? "the parent agent"
                                : $"subagent '{stepFinished.SubagentRunId}'";
                            var actual = open.Owner is null
                                ? "the parent agent"
                                : $"subagent '{open.Owner}'";
                            throw new System.InvalidOperationException(
                                $"Cannot send 'STEP_FINISHED' for step \"{stepFinished.StepName}\" attributed to {attributed}: "
                                + $"that step is open under {actual}. A step must be finished by whoever started it.");
                        }

                        throw new System.InvalidOperationException(
                            $"Cannot send 'STEP_FINISHED' for step \"{stepFinished.StepName}\" that was not started.");
                    }

                    {
                        var update = new ChatResponseUpdate
                        {
                            Role = ChatRole.Assistant,
                            ConversationId = conversationId,
                            ResponseId = responseId,
                            RawRepresentation = stepFinished
                        };
                        if (toolCallBuilder.IsBuffering)
                        {
                            toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                        }
                        else
                        {
                            yield return update;
                        }
                    }
                    break;

                case ToolCallStartEvent toolStart:
                    toolCallBuilder.StartToolCall(toolStart);
                    break;

                case ToolCallArgsEvent toolArgs:
                    toolCallBuilder.AppendArgs(toolArgs);
                    break;

                case ToolCallEndEvent toolEnd:
                    toolCallBuilder.EndToolCall(toolEnd, jsonSerializerOptions);
                    break;

                case ToolCallResultEvent toolResult:
                {
                    // A FunctionResultContent holds ONE result object, so a multimodal tool
                    // result is projected to its text parts concatenated — the flattening
                    // AGUIContent.ToString performs and AGUIContent documents. The
                    // specification permits the lossy rendering but asks for it to be
                    // announced (tool-calls.mdx, "Result content"), and a dropped document
                    // or image is otherwise indistinguishable from one the producer never
                    // sent. One warning per result, naming how much went missing.
                    WarnOnFlattenedToolResult(toolResult);

                    var resultUpdate = new ChatResponseUpdate(ChatRole.Tool,
                        [new FunctionResultContent(toolResult.ToolCallId, toolResult.Content.ToString())])
                    {
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        // The wire id of the tool message this event mints. Without it the
                        // coalescer hoists the update's attribution onto the ChatResponse
                        // instead of the message (see ToolCallBuilder.EndToolCall).
                        MessageId = toolResult.MessageId,
                        RawRepresentation = toolResult
                    };

                    if (toolCallBuilder.IsBuffering)
                    {
                        // Add the result to the buffer and resolve the pending tool call.
                        // If all pending tool calls now have results, flush the entire buffer.
                        foreach (var flushed in toolCallBuilder.AddResult(toolResult.ToolCallId, resultUpdate))
                        {
                            yield return flushed;
                        }
                    }
                    else
                    {
                        yield return resultUpdate;
                    }
                    break;
                }

                case ReasoningMessageContentEvent reasoningContent:
                {
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        // Message identity keeps the update's attribution on the message
                        // through ToChatResponse (see ToolCallBuilder.EndToolCall).
                        MessageId = reasoningContent.MessageId,
                        Contents = [new TextReasoningContent(reasoningContent.Delta) { RawRepresentation = reasoningContent }],
                        RawRepresentation = reasoningContent
                    };
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                case ReasoningEncryptedValueEvent encryptedValue:
                {
                    // `subtype` selects the namespace: a message-scoped value's EntityId IS
                    // its message id; a call-scoped value joins the message minted for its
                    // call (see ToolCallBuilder.EndToolCall for why identity is required).
                    var encryptedMessageId = encryptedValue.Subtype == "tool-call"
                        ? (encryptedValue.EntityId is { } callId
                            ? toolCallBuilder.MintedMessageIdFor(callId) ?? callId
                            : null)
                        : encryptedValue.EntityId;
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        MessageId = encryptedMessageId,
                        Contents = [new TextReasoningContent(null) { ProtectedData = encryptedValue.EncryptedValue, RawRepresentation = encryptedValue }],
                        RawRepresentation = encryptedValue
                    };
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }

                // Pass-through events: state, reasoning lifecycle, activity, custom, raw,
                // and the subagent lifecycle. The subagent events reach the caller as
                // RawRepresentation because Microsoft.Extensions.AI has no concept of
                // delegated work; a consumer that cares reads them off the update, while
                // the validation above has already rejected an inconsistent lifecycle.
                case SubagentStartedEvent:
                case SubagentFinishedEvent:
                case SubagentErrorEvent:
                case StateSnapshotEvent:
                case StateDeltaEvent:
                case ReasoningStartEvent:
                case ReasoningMessageStartEvent:
                case ReasoningMessageEndEvent:
                case ReasoningEndEvent:
                case ReasoningMessageChunkEvent:
                case ActivitySnapshotEvent:
                case ActivityDeltaEvent:
                case CustomEvent:
                case RawEvent:
                default:
                {
                    var update = new ChatResponseUpdate
                    {
                        Role = ChatRole.Assistant,
                        ConversationId = conversationId,
                        ResponseId = responseId,
                        RawRepresentation = evt
                    };
                    // The lane the validation inferred for an id-less reasoning chunk —
                    // unresolvable through the owner maps (no MessageId), so it is
                    // stamped here directly. StampOwner below only ADDS a key when its
                    // own resolution succeeds, so this survives buffering unchanged.
                    if (inferredReasoningChunkOwner is not null)
                    {
                        update.AdditionalProperties ??= new AdditionalPropertiesDictionary();
                        update.AdditionalProperties[AGUISubagentRunIdKey] = inferredReasoningChunkOwner;
                    }
                    if (toolCallBuilder.IsBuffering)
                    {
                        toolCallBuilder.BufferUpdate(StampOwner(update, owners));
                    }
                    else
                    {
                        yield return update;
                    }
                    break;
                }
            }
        }

        // The stream is over. A run that was opened and never closed is TRUNCATED: "A
        // truncated run has no outcome. A consumer MUST NOT synthesize a RUN_FINISHED for
        // it and MUST NOT report it as having succeeded" (transports/index.mdx,
        // "Truncation"). Completing the enumeration normally is exactly reporting success
        // to an IChatClient caller, which reads the run as finished with whatever arrived —
        // so the failure is raised here instead, and everything delivered before the break
        // stays delivered.
        //
        // Deliberately at the END of the iterator body rather than in a finally: a consumer
        // that stops enumerating early — `break`, a `Take`, a cancellation — suspends the
        // iterator at its yield and disposes it, and that is its own decision to stop, not a
        // producer truncating the stream. Code after the loop does not run in that case,
        // which is precisely the wanted behaviour.
        if (runStarted && !runFinished && !runError)
        {
            throw new System.InvalidOperationException(
                $"The event stream ended without a terminal event: run '{openRunId}' on thread '{openThreadId}' was started but never closed with 'RUN_FINISHED' or 'RUN_ERROR'. A truncated run must not be reported as successful.");
        }

        if (!runStarted && !runError)
        {
            throw new System.InvalidOperationException(
                "The event stream ended without a terminal event: no 'RUN_STARTED' arrived, so no run was opened and none can be reported as successful.");
        }
    }

    /// <summary>
    /// Warns once for a tool result whose non-text parts the string projection drops.
    /// </summary>
    private static void WarnOnFlattenedToolResult(ToolCallResultEvent toolResult)
    {
        if (toolResult.Content.Value is not IList<AGUIInputContent> parts)
        {
            return;
        }

        var dropped = 0;
        foreach (var part in parts)
        {
            if (part is not AGUITextInputContent)
            {
                dropped++;
            }
        }

        if (dropped > 0)
        {
            Trace.TraceWarning(
                "[ag-ui] The result of tool call '{0}' was flattened to text; {1} non-text part(s) were dropped.",
                toolResult.ToolCallId,
                dropped);
        }
    }

    /// <summary>
    /// Throws when a reasoning-message continuation or close names a message that is not
    /// open. Mirrors verifyEvents: the reducer is never left to invent a message for an
    /// orphaned fragment.
    /// </summary>
    private static void RequireOpenReasoningMessage(HashSet<string> open, string eventType, string messageId)
    {
        if (!open.Contains(messageId))
        {
            throw new System.InvalidOperationException(
                $"Cannot send '{eventType}' event: No active reasoning message found with ID '{messageId}'. Start a reasoning message with 'REASONING_MESSAGE_START' first.");
        }
    }

    /// <summary>
    /// Throws when a protocol-required string was ABSENT from the payload.
    /// </summary>
    /// <remarks>
    /// The TypeScript schemas mark these mandatory with <c>z.string()</c>, which
    /// requires the key to be present but accepts an empty value — so this checks for
    /// null, not for empty. The properties are declared nullable precisely to make that
    /// distinction possible: were they non-nullable with a <c>string.Empty</c>
    /// initializer, a missing property and an explicit <c>""</c> would be
    /// indistinguishable, and rejecting both would make .NET stricter than TypeScript
    /// and Python, which is the divergence this is here to prevent.
    /// </remarks>
    private static void RequireProvided(string? value, string propertyName, string eventType)
    {
        if (value is null)
        {
            throw new System.InvalidOperationException(
                $"Cannot send '{eventType}': '{propertyName}' is required.");
        }
    }

    /// <summary>
    /// Throws when a continuation or close event names a different subagent than the
    /// one that opened the entity. An absent tag is not a disagreement: attribution is
    /// optional per event, so producers that tag only openers remain valid.
    /// </summary>
    private static void RejectOwnerMismatch(
        string eventType,
        string? subagentRunId,
        Dictionary<string, string?> owners,
        string entityId,
        string entityKind)
    {
        if (subagentRunId is null)
        {
            return;
        }

        // A recorded owner of null means the entity belongs to the PARENT, which is just
        // as much an owner as a subagent — so a tagged continuation on it is still a
        // disagreement. Only the ABSENCE of an entry means "unknown opener".
        if (owners.TryGetValue(entityId, out var owner) && owner != subagentRunId)
        {
            throw new System.InvalidOperationException(
                $"Cannot send '{eventType}': subagentRunId '{subagentRunId}' does not match the {entityKind} '{entityId}' opener's subagent '{owner}'.");
        }
    }
    // The AdditionalCounts key that carries AG-UI's cache-write count, which MEAI has
    // no first-class property for. The same key AGUI.Server reads, so a count survives a
    // .NET-to-.NET hop through the abstraction unchanged.
    internal const string CacheWriteInputTokensCountKey = "CacheWriteInputTokens";

    // Inverse of the AGUI.Server mapping. Every AG-UI count but one has a first-class
    // MEAI equivalent, and null stays null on both sides so a count the provider never
    // reported is not reported as zero. The cache-write count rides in AdditionalCounts
    // under the key above, and only when it was reported — an empty dictionary would
    // read as "reported nothing" to a consumer that checks for the key.
    private static UsageDetails ToUsageDetails(TokenUsage usage)
    {
        var details = new UsageDetails
        {
            InputTokenCount = usage.InputTokens,
            OutputTokenCount = usage.OutputTokens,
            TotalTokenCount = usage.TotalTokens,
            ReasoningTokenCount = usage.ReasoningTokens,
            CachedInputTokenCount = usage.CachedInputTokens,
        };

        if (usage.CacheWriteInputTokens is { } cacheWriteInputTokens)
        {
            details.AdditionalCounts = new() { [CacheWriteInputTokensCountKey] = cacheWriteInputTokens };
        }

        return details;
    }
}
