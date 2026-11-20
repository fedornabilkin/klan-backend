import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { Presence } from './presence.js';

class Tab extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages: object[] = [];
  pings = 0;
  send(data: string) { this.messages.push(JSON.parse(data)); }
  ping() { this.pings++; }
  terminate() { this.emit('close'); }
}

test('presence counts a member once across tabs and expires a dropped connection', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const presence = new Presence();
  const connect = (id: string) => {
    const tab = new Tab();
    presence.connect(tab as unknown as WebSocket, id);
    return tab;
  };
  const alice = connect('alice'), bob = connect('bob'), secondBob = connect('bob');
  assert.deepEqual(secondBob.messages, [{ type: 'presence', online: ['alice', 'bob'] }]);
  t.mock.timers.tick(400);
  assert.deepEqual(alice.messages.at(-1), { type: 'presence', joined: ['alice', 'bob'], left: [] });
  alice.messages.length = 0;
  bob.terminate();
  t.mock.timers.tick(400);
  assert.deepEqual(alice.messages, []);
  presence.heartbeat();
  alice.emit('pong');
  presence.heartbeat();
  t.mock.timers.tick(400);
  assert.equal(alice.pings, 2);
  assert.deepEqual(alice.messages, [{ type: 'presence', joined: [], left: ['bob'] }]);
  const roamed = connect('bob');
  roamed.terminate();
  const reopened = connect('bob');
  t.mock.timers.tick(400);
  assert.deepEqual(reopened.messages[0], { type: 'presence', online: ['alice', 'bob'] });
  assert.deepEqual(alice.messages.at(-1), { type: 'presence', joined: ['bob'], left: [] });
});
