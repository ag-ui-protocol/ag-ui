// Bounded helpers for the e2e driver's CAO status polling. Every request has
// its own timeout and every loop has a wall-clock deadline, so a server that
// accepts a connection and never answers fails the phase instead of hanging it.

export const REQUEST_TIMEOUT_MS = 3_000;

export async function caoStatus(
  caoUrl,
  session,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const get = async (path) => {
    const res = await fetch(`${caoUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  const [terminal] = await get(`/sessions/${session}/terminals`);
  if (!terminal) throw new Error("the session has no terminal");
  return (await get(`/terminals/${terminal.id}`)).status;
}

// Calls `probe` until it returns true or `deadlineMs` of wall-clock time has
// passed. A probe that throws (synchronously or not) counts as "not yet". The
// deadline holds while a probe is pending, and a probe that settles after it
// does not count as success.
export async function pollUntil(probe, deadlineMs, intervalMs = 500) {
  const end = Date.now() + deadlineMs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < end) {
    let timer;
    const timedOut = new Promise((r) => {
      timer = setTimeout(() => r(false), Math.max(0, end - Date.now()));
    });
    const attempt = (async () => (await probe()) === true)().catch(() => false);
    const ok = await Promise.race([attempt, timedOut]);
    clearTimeout(timer);
    if (ok && Date.now() <= end) return true;
    const left = end - Date.now();
    if (left <= 0) break;
    await wait(Math.min(intervalMs, left));
  }
  return false;
}
