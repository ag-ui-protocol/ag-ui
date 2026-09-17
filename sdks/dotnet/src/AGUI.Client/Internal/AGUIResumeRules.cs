using System;
using System.Collections.Generic;
using System.Globalization;
using AGUI.Abstractions;

namespace AGUI.Client;

/// <summary>
/// The consumer's half of the interrupt/resume contract, applied to a
/// <see cref="RunAgentInput"/> before it is sent.
/// </summary>
/// <remarks>
/// <para>
/// The specification puts these checks on the CONSUMER and asks it to make them before
/// anything goes on the wire: "A consumer MUST reject a resuming input that leaves an
/// interrupt uncovered before the run starts — before anything is sent — and MUST NOT
/// silently continue past an interrupt it has no entry for"
/// (<c>docs/spec/draft/basic/patterns/interrupt-resume.mdx</c>, "Resuming"). Expiry is on
/// the same page and in the same place: "an interrupt the consumer judges expired can no
/// longer be answered — the consumer rejects a resume entry resolving it before the run
/// starts, as it rejects an uncovered interrupt. It can still be — and, coverage being
/// mandatory, must be — abandoned."
/// </para>
/// <para>
/// An entry naming an interrupt that was never raised is rejected here too. The page's
/// tolerance for one ("the run SHOULD proceed without the entry, and the producer SHOULD
/// surface a warning") sits under the heading that introduces it as the PRODUCER's error
/// handling for violations that "can nevertheless reach a producer… not permission to send
/// them". This client is the consumer assembling the list, which is the role TypeScript's
/// <c>buildResumeArray</c> plays — and that helper throws on both a missing and an unknown
/// id. Sending one anyway would be sending a violation the spec names as such.
/// </para>
/// <para>
/// Duplicates are rejected for the reason the coverage rule exists: each interrupt's id is
/// unique within the run (same page), so two entries for one id cannot both be answers, and
/// a set-based coverage check would let the duplicate stand in for an interrupt nobody
/// answered — the silent skip coverage is there to prevent.
/// </para>
/// </remarks>
internal static class AGUIResumeRules
{
    /// <summary>
    /// Validates <paramref name="resume"/> against the interrupts the run being continued
    /// left open. Throws <see cref="InvalidOperationException"/> on the first violation.
    /// </summary>
    /// <param name="pending">
    /// The interrupts carried by the last <c>RUN_FINISHED</c> for this thread. Empty means
    /// the thread is not resuming, and a resume list is then not checked against anything:
    /// a caller that hand-supplies one through <c>RawRepresentationFactory</c> may be
    /// continuing a run this client never saw.
    /// </param>
    /// <param name="resume">The entries about to be sent.</param>
    internal static void Validate(IReadOnlyList<AGUIInterrupt> pending, IList<AGUIResume>? resume)
    {
        if (pending.Count == 0)
        {
            return;
        }

        var entries = resume ?? [];

        // Duplicates first: every check below reads the list as a map from interrupt id to
        // one decision, and a duplicate makes that reading false before it is made.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (!seen.Add(entry.InterruptId))
            {
                throw new InvalidOperationException(
                    $"Cannot start a run: 'resume' answers interrupt '{entry.InterruptId}' more than once. Each interrupt of the run being continued is answered by exactly one entry.");
            }
        }

        var open = new HashSet<string>(StringComparer.Ordinal);
        foreach (var interrupt in pending)
        {
            open.Add(interrupt.Id);
        }

        var unknown = new List<string>();
        foreach (var entry in entries)
        {
            if (!open.Contains(entry.InterruptId))
            {
                unknown.Add(entry.InterruptId);
            }
        }

        if (unknown.Count > 0)
        {
            throw new InvalidOperationException(
                $"Cannot start a run: 'resume' names {unknown.Count} interrupt(s) the run being continued did not raise: {string.Join(", ", unknown)}. An entry's interruptId must name an interrupt of that run.");
        }

        var uncovered = new List<string>();
        foreach (var interrupt in pending)
        {
            if (!seen.Contains(interrupt.Id))
            {
                uncovered.Add(interrupt.Id);
            }
        }

        if (uncovered.Count > 0)
        {
            throw new InvalidOperationException(
                $"Cannot start a run: {uncovered.Count} pending interrupt(s) are not addressed by 'resume': {string.Join(", ", uncovered)}. Every interrupt of the run being continued must be answered or cancelled — omission is not abandonment.");
        }

        // Expiry forecloses ANSWERING, not moving on: a cancelled entry is the conforming
        // way past an interrupt nobody answered in time. Rejecting an expired interrupt on
        // presence alone would block its thread forever, since coverage is mandatory and no
        // entry could then satisfy both rules.
        foreach (var interrupt in pending)
        {
            if (!IsExpired(interrupt))
            {
                continue;
            }

            foreach (var entry in entries)
            {
                if (!string.Equals(entry.InterruptId, interrupt.Id, StringComparison.Ordinal)
                    || string.Equals(entry.Status, ResumeStatus.Cancelled, StringComparison.Ordinal))
                {
                    continue;
                }

                throw new InvalidOperationException(
                    $"Cannot start a run: interrupt '{interrupt.Id}' expired at '{interrupt.ExpiresAt}' and can no longer be resolved. Cancel it to continue the thread.");
            }
        }
    }

    /// <summary>
    /// Whether an interrupt has expired, judged the way the reference client judges it:
    /// read <c>expiresAt</c> as a date and treat now-or-earlier as expired.
    /// </summary>
    /// <remarks>
    /// <c>expiresAt</c> is deliberately format-unconstrained in the schema, so the rule
    /// attaches to the consumer's own reading of the value rather than to a parse the
    /// schema refuses to specify. A value that is not a date leaves the interrupt looking
    /// permanently unexpired, which is what the model's own documentation says and what
    /// TypeScript's <c>isInterruptExpired</c> does with an unparseable string.
    /// </remarks>
    internal static bool IsExpired(AGUIInterrupt interrupt, DateTimeOffset? now = null)
    {
        if (string.IsNullOrEmpty(interrupt.ExpiresAt))
        {
            return false;
        }

        if (!DateTimeOffset.TryParse(
                interrupt.ExpiresAt,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out var expiresAt))
        {
            return false;
        }

        return expiresAt <= (now ?? DateTimeOffset.UtcNow);
    }
}
