// Harness-only no-op stand-in for the agora-chat SDK (aliased in
// e2e/harness/vite.config.ts). open() resolves so the chat status reaches
// 'connected' the way it does on a phone; nothing is sent anywhere.

type Handler = Record<string, unknown>;

let sequence = 0;

class HarnessConnection {
  private readonly handlers = new Map<string, Handler>();

  open(): Promise<{ accessToken: string }> {
    return Promise.resolve({ accessToken: 'harness' });
  }

  close(): void {
    this.handlers.clear();
  }

  renewToken(): Promise<{ status: boolean }> {
    return Promise.resolve({ status: true });
  }

  addEventHandler(id: string, handler: Handler): void {
    this.handlers.set(id, handler);
  }

  removeEventHandler(id: string): void {
    this.handlers.delete(id);
  }

  send(): Promise<{ serverMsgId: string; localMsgId: string }> {
    sequence += 1;
    return Promise.resolve({ serverMsgId: `harness-${sequence}`, localMsgId: `local-${sequence}` });
  }

  subscribePresence(): Promise<{ data: { result: never[] } }> {
    return Promise.resolve({ data: { result: [] } });
  }

  unsubscribePresence(): Promise<void> {
    return Promise.resolve();
  }
}

const harnessSdk = {
  connection: HarnessConnection,
  message: {
    create<T extends object>(options: T): T & { id: string } {
      sequence += 1;
      return { ...options, id: `harness-msg-${sequence}` };
    },
  },
};

export default harnessSdk;
