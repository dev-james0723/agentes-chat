import { GeometryTransportError } from "./browser";

export interface DisposableSession<S> {
  value: S;
  close(): Promise<void>;
}

/**
 * A worker owns exactly one browser pair. Measurements have no side effects outside that pair.
 * A failed capture never returns partial findings. Only typed transport failures are retryable.
 */
export function resilientWorker<S, R>(options: {
  open: () => Promise<DisposableSession<S>>;
  measure: (session: S, name: string) => Promise<R>;
  signal: AbortSignal;
  onRetry?: (name: string, attempt: number, error: unknown) => void;
  attempts?: number;
  recycleEvery?: number;
}) {
  const attempts = options.attempts ?? 3;
  const recycleEvery = options.recycleEvery ?? 100;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error("Invalid geometry retry limit");
  if (!Number.isInteger(recycleEvery) || recycleEvery < 1) throw new Error("Invalid geometry recycle limit");
  let session: DisposableSession<S> | undefined;
  let measured = 0;
  let cleanupError: Error | undefined;
  const close = async () => {
    if (!session) return;
    const owned = session;
    session = undefined;
    measured = 0;
    // A cleanup failure is not transport recovery. Never launch another browser after uncertain cleanup.
    try {
      await owned.close();
    } catch (error) {
      cleanupError = new Error("Geometry worker cleanup failed", { cause: error });
      throw cleanupError;
    }
  };
  const measure = async (name: string): Promise<R> => {
    if (cleanupError) throw cleanupError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      options.signal.throwIfAborted();
      try {
        if (measured >= recycleEvery) await close();
        session ??= await options.open();
        options.signal.throwIfAborted();
        const result = await options.measure(session.value, name);
        options.signal.throwIfAborted();
        measured++;
        return result;
      } catch (error) {
        await close();
        options.signal.throwIfAborted();
        if (!(error instanceof GeometryTransportError) || attempt >= attempts)
          throw new Error(`Geometry capture ${name} failed (attempt ${attempt}/${attempts})`, { cause: error });
        options.onRetry?.(name, attempt, error);
      }
    }
    throw new Error("Geometry retry budget exhausted");
  };
  return { measure, close };
}
