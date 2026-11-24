import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Bound every wait, including socket opening and child shutdown. Clear the timer on success or failure. */
export function deadline<T>(operation: string, work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (error?: unknown, result?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(result as T);
    };
    const abort = () => finish(signal?.reason ?? new Error(`${operation}: canceled`));
    const timer = setTimeout(() => finish(new Error(`${operation}: timed out after ${ms}ms`)), ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    // Attach handlers even when already aborted, so a late rejection is never unhandled.
    work.then(
      (result) => finish(undefined, result),
      (error) => finish(error),
    );
  });
}

export function boundedMs(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}ms`);
  return n;
}

export interface BrowserOptions {
  startupMs?: number;
  connectMs?: number;
  callMs?: number;
  closeMs?: number;
  signal?: AbortSignal;
}

type Waiting = { ok: (value: never) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A failed or unresponsive CDP transport is terminal, never silently retried or mistaken for a successful layout. */
export async function connectCdp(url: string, options: BrowserOptions = {}) {
  const connectMs = options.connectMs ?? boundedMs("GEOMETRY_CONNECT_MS", 15_000, 100, 120_000);
  const callMs = options.callMs ?? boundedMs("GEOMETRY_CDP_MS", 30_000, 100, 120_000);
  const signal = options.signal;
  signal?.throwIfAborted();
  const ws = new WebSocket(url);
  let failure: Error | undefined;
  let id = 0;
  const waiting = new Map<number, Waiting>();
  let opened!: () => void;
  let rejectOpen!: (error: Error) => void;
  const opening = new Promise<void>((resolve, reject) => {
    opened = resolve;
    rejectOpen = reject;
  });
  const fail = (reason: unknown) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error(String(reason));
    signal?.removeEventListener("abort", abort);
    rejectOpen(failure);
    for (const call of waiting.values()) {
      clearTimeout(call.timer);
      call.fail(failure);
    }
    waiting.clear();
    try {
      ws.close();
    } catch {
      // The browser can already have disconnected. All outstanding promises are settled above.
    }
  };
  const abort = () => fail(signal?.reason ?? new Error("CDP canceled"));
  ws.onopen = () => opened();
  ws.onerror = () => fail(new Error("CDP socket error"));
  ws.onclose = () => fail(new Error("CDP socket closed"));
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      const call = waiting.get(message.id);
      if (!call) return; // Event, or an already canceled request.
      waiting.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.fail(new Error(message.error.message ?? "CDP request failed"));
      else call.ok(message.result as never);
    } catch (error) {
      fail(error);
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await deadline("CDP connect", opening, connectMs, signal);
  } catch (error) {
    fail(error);
    throw error;
  }
  const send = <T = Record<string, never>>(method: string, params: object = {}, sessionId?: string): Promise<T> =>
    new Promise<T>((ok, reject) => {
      if (failure || ws.readyState !== WebSocket.OPEN) {
        reject(failure ?? new Error(`CDP ${method}: socket is not open`));
        return;
      }
      const requestId = ++id;
      const timer = setTimeout(() => fail(new Error(`CDP ${method}: timed out after ${callMs}ms`)), callMs);
      waiting.set(requestId, { ok: ok as (value: never) => void, fail: reject, timer });
      try {
        ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
      } catch (error) {
        fail(error);
      }
    });
  return { send, close: () => fail(new Error("CDP closed by geometry runner")) };
}

async function stopChrome(chrome: ReturnType<typeof Bun.spawn>, closeMs: number) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return;
  chrome.kill("SIGTERM");
  try {
    await deadline("Chrome graceful shutdown", chrome.exited, closeMs);
  } catch {
    chrome.kill("SIGKILL");
    await deadline("Chrome forced shutdown", chrome.exited, closeMs);
  }
}

/** Chrome writes this file to our unique profile once the browser CDP endpoint is ready. Never depend on stderr chunks. */
function endpoint(profile: string) {
  try {
    const [portText, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    const port = Number(portText);
    if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path ?? ""))
      return `ws://127.0.0.1:${port}${path}`;
  } catch {
    // Chrome has not atomically finished writing the endpoint file yet.
  }
  return undefined;
}

export async function launch(bin: string, profile: string, options: BrowserOptions = {}) {
  const startupMs = options.startupMs ?? boundedMs("GEOMETRY_STARTUP_MS", 30_000, 100, 120_000);
  const closeMs = options.closeMs ?? 3_000;
  const own = new AbortController();
  const signal = options.signal ? AbortSignal.any([own.signal, options.signal]) : own.signal;
  signal.throwIfAborted();
  const chrome = Bun.spawn(
    [
      bin,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--allow-file-access-from-files",
      "--font-render-hinting=none",
      "--hide-scrollbars",
      // Both CSS-order tabs must lay out even while the other one is selected.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      // Dedicated disposable profiles must not launch background services or update jobs.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-extensions",
      "--disable-breakpad",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  // Keep the diagnostic pipe draining, independently of startup and CDP work.
  let log = "";
  const reader = chrome.stderr.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        log = (log + decoder.decode(value, { stream: true })).slice(-2000);
      }
    } catch {
      // Browser exit/cleanup is handled by the process lifecycle below.
    }
  })();
  void chrome.exited.then((code) => own.abort(new Error(`Chrome exited (${code}): ${log.slice(-500)}`)));
  let connection: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    own.abort(new Error("Geometry browser closing"));
    connection?.close();
    closing = stopChrome(chrome, closeMs);
    return closing;
  };
  try {
    const start = Date.now();
    let url = endpoint(profile);
    while (!url) {
      signal.throwIfAborted();
      if (Date.now() - start >= startupMs)
        throw new Error(`Chrome startup: timed out after ${startupMs}ms (pid=${chrome.pid}); ${log.slice(-500)}`);
      await deadline("Chrome startup poll", Bun.sleep(50), Math.max(startupMs, 100), signal);
      url = endpoint(profile);
    }
    connection = await connectCdp(url, { ...options, signal });
    return { send: connection.send, close, pid: chrome.pid };
  } catch (error) {
    await close();
    throw error;
  }
}
