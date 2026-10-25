/**
 * Local seam interfaces for the parts of pimatrix that piprogram used to import.
 *
 * These are the minimal shapes piprogram reads or calls. They are not copies of
 * the pimatrix implementations. Whatever host embeds piprogram must provide
 * objects that satisfy them.
 */

/**
 * The stream fields the pipgm service reads (`state.stream.state`) and
 * writes (its default "disabled" snapshot, and the copy returned to callers).
 * `state` is typed as a string because piprogram only compares it with
 * "running" and assigns "disabled"; the host decides the full set of values.
 */
export interface ManagedStreamSnapshot {
  state: string;
  jobId: string | null;
  attempt: number;
  lastError: string | null;
  stderrTail: string | null;
}

/**
 * The event broker surface piprogram calls: `this.eventBroker?.emit({ type, data })`.
 * The broker is optional at the call site, so a host may omit it.
 */
export interface PiMatrixEventBroker {
  emit(event: { type: string; data: unknown }): void;
}
