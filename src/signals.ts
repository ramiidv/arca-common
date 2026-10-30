/**
 * Combina varios AbortSignal en uno que se aborta cuando se aborta cualquiera.
 * Ignora los `undefined`; si queda uno solo, lo devuelve tal cual.
 *
 * Usa `AbortSignal.any` cuando existe (Node >= 20.3). En Node 18 combina con
 * listeners, que quedan registrados en los signals de origen hasta que alguno
 * se aborta.
 */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length <= 1) return present[0];

  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, present);

  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal).reason);
    for (const s of present) s.removeEventListener('abort', onAbort);
  };
  for (const s of present) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
