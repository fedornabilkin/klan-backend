import { WebSocket } from 'ws';

// Count tabs by authenticated user, and coalesce changes before notifying the other tabs.
export class Presence {
  private readonly counts = new Map<string, number>();
  private readonly clients = new Set<WebSocket>();
  private readonly waitingForPong = new WeakSet<WebSocket>();
  private readonly changes = new Map<string, boolean>();
  private timer?: ReturnType<typeof setTimeout>;

  userIds() { return [...this.counts.keys()]; }

  connect(socket: WebSocket, userId: string) {
    this.clients.add(socket);
    const count = this.counts.get(userId) ?? 0;
    this.counts.set(userId, count + 1);
    if (!count) this.changed(userId, true);
    socket.on('pong', () => this.waitingForPong.delete(socket));
    socket.once('close', () => {
      this.clients.delete(socket);
      const remaining = this.counts.get(userId)! - 1;
      if (remaining) this.counts.set(userId, remaining);
      else {
        this.counts.delete(userId);
        this.changed(userId, false);
      }
    });
    socket.send(JSON.stringify({ type: 'presence', online: this.userIds() }));
  }

  heartbeat() {
    for (const socket of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (this.waitingForPong.has(socket)) socket.terminate();
      else {
        this.waitingForPong.add(socket);
        socket.ping();
      }
    }
  }

  private changed(id: string, online: boolean) {
    this.changes.set(id, online);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const joined: string[] = [], left: string[] = [];
      for (const [user, present] of this.changes) (present ? joined : left).push(user);
      this.changes.clear();
      const message = JSON.stringify({ type: 'presence', joined, left });
      for (const socket of this.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (socket.bufferedAmount > 1024 * 1024) socket.terminate();
        else socket.send(message);
      }
    }, 350);
    this.timer.unref();
  }
}
