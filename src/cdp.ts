/**
 * A tiny Chrome DevTools Protocol client over the WebSocket built into Node 24 (no library).
 * It only does what the frame renderer needs: request/response with optional flat-session ids,
 * and waiting for one event.
 */

/** The part of the WebSocket API used here, so tests can pass a fake. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void): void;
}

export type CdpSocketFactory = (url: string) => CdpSocket;

export class CdpDisconnectedError extends Error {
  constructor(message = "The browser connection was lost") {
    super(message);
    this.name = "CdpDisconnectedError";
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  method: string;
  sessionId?: string;
  resolve: (params: any) => void;
  reject: (error: Error) => void;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private waiters = new Set<Waiter>();
  private closed = false;
  private readonly closeListeners: Array<() => void> = [];

  private constructor(private readonly socket: CdpSocket) {
    socket.addEventListener("message", (event) => this.onMessage(typeof event.data === "string" ? event.data : String(event.data)));
    socket.addEventListener("close", () => this.fail(new CdpDisconnectedError()));
    socket.addEventListener("error", () => this.fail(new CdpDisconnectedError()));
  }

  static connect(url: string, factory: CdpSocketFactory = (u) => new WebSocket(u) as unknown as CdpSocket): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let socket: CdpSocket;
      try {
        socket = factory(url);
      } catch (error) {
        return reject(error);
      }
      let opened = false;
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => {
        opened = true;
        resolve(client);
      });
      socket.addEventListener("error", () => {
        if (!opened) reject(new CdpDisconnectedError("Could not connect to the browser DevTools endpoint"));
      });
      socket.addEventListener("close", () => {
        if (!opened) reject(new CdpDisconnectedError("Could not connect to the browser DevTools endpoint"));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpDisconnectedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /** Resolves with the params of the next matching event (register before the command that causes it). */
  waitForEvent<T = any>(method: string, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpDisconnectedError());
    return new Promise<T>((resolve, reject) => {
      this.waiters.add({ method, sessionId, resolve, reject });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
    this.fail(new CdpDisconnectedError());
  }

  private onMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP error: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (const waiter of [...this.waiters]) {
        if (waiter.method === message.method && (waiter.sessionId === undefined || waiter.sessionId === message.sessionId)) {
          this.waiters.delete(waiter);
          waiter.resolve(message.params ?? {});
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}
