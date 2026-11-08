/** Allow modest Zulip/server clock skew, but never unbounded future activity. */
const MAX_FUTURE_MESSAGE_SKEW_MS = 60_000;

/**
 * Validate a Zulip message's epoch milliseconds against local receipt time.
 * Reject (rather than clamp) timestamps over one minute ahead: an implausible
 * clock must neither prove this launch posted nor postpone its idle check.
 * Share this policy between event intake and history lookup results.
 */
export function isPlausibleMessageTime(timestamp: number | undefined, receivedAt = Date.now()): timestamp is number {
  return timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0 &&
    timestamp <= receivedAt + MAX_FUTURE_MESSAGE_SKEW_MS;
}
