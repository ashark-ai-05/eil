/**
 * SYNTHETIC DEMO CONTENT. Illustrative only, written for a capability
 * demonstration. Not a production reference. Do not cite in design or change
 * documentation.
 *
 * Restricted instrument list.
 *
 * The list itself is owned by Compliance, not by us. We load it at start of
 * day and hold it in memory for the order path; we do not edit it, and there
 * is no runtime endpoint that adds to or removes from it. Requests to
 * "temporarily" drop a name go to Compliance.
 */

let restricted: ReadonlySet<string> = new Set();
let loaded = false;

/** Replace the list wholesale. Called at start of day, never on the order path. */
export function loadRestrictedList(instruments: Iterable<string>): void {
  restricted = new Set(instruments);
  loaded = true;
}

/**
 * Whether an instrument is restricted.
 *
 * Returns true when the list has never been loaded. An unloaded list is a
 * control that cannot be evaluated, and the defensible behaviour is to treat
 * everything as restricted rather than to wave everything through — the
 * gateway should not be opening a session in this state anyway.
 */
export function isRestricted(instrument: string): boolean {
  if (!loaded) return true;
  return restricted.has(instrument);
}

export function restrictedListSize(): number {
  return restricted.size;
}
