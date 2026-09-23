import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Storage } from './storage.ts';
import { randomUUID } from 'node:crypto';
import { HiveBus } from './hive-events.ts';
import { Hive } from './hive.ts';
import { hasRow } from './test-fixtures.ts';
import type { Message } from '../shared/types.ts';

function open(file: string, t: TestContext) {
  const handle = new DatabaseSync(file);
  t.after(() => handle.close());
  handle.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON');
  return handle;
}

function fixture(t: TestContext, file = ':memory:') {
  const handle = file === ':memory:' ? new DatabaseSync(file) : open(file, t);
  if (file === ':memory:') t.after(() => handle.close());
  handle.exec('CREATE TABLE IF NOT EXISTS effects(value TEXT NOT NULL)');
  const storage = Storage.for(handle);
  const insert = (value: string) => handle.prepare('INSERT INTO effects VALUES(?)').run(value);
  const values = () => handle.prepare('SELECT value FROM effects ORDER BY rowid').all().map(row => row.value);
  return { handle, storage, insert, values };
}

function tempFile(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'hive.db');
}

test('one Storage per handle: every module sharing a connection shares its unit of work', t => {
  const a = new DatabaseSync(':memory:'), b = new DatabaseSync(':memory:');
  t.after(() => { a.close(); b.close(); });
  assert.equal(Storage.for(a), Storage.for(a));
  assert.notEqual(Storage.for(a), Storage.for(b));
  assert.equal(Storage.for(a).db, a);
});

test('a transaction commits before returning its exact result', t => {
  const { storage, insert, values } = fixture(t), result = { committed: true };
  assert.equal(storage.transaction(() => { insert('saved'); return result; }), result);
  assert.deepEqual(values(), ['saved']);
  assert.equal(storage.active, false);
});

test('nested transactions compose instead of failing with "transaction within a transaction"', t => {
  const { storage, insert, values } = fixture(t);
  storage.transaction(() => {
    insert('outer');
    storage.transaction(() => {
      insert('inner');
      storage.transaction(() => insert('innermost'), { immediate: false });
    });
    assert.equal(storage.active, true);
  });
  assert.deepEqual(values(), ['outer', 'inner', 'innermost']);
});

test('an inner failure rolls back only its own savepoint and its effects', t => {
  const { storage, insert, values } = fixture(t), ran: string[] = [];
  storage.transaction(() => {
    insert('outer-before');
    storage.afterCommit(() => ran.push('outer'));
    assert.throws(() => storage.transaction(() => {
      insert('inner');
      storage.afterCommit(() => ran.push('inner'));
      throw new Error('inner failure');
    }), /inner failure/);
    insert('outer-after');
    assert.deepEqual(ran, [], 'effects wait for the outermost commit');
  });
  assert.deepEqual(values(), ['outer-before', 'outer-after']);
  assert.deepEqual(ran, ['outer']);
});

test('an outer failure rolls back every level, including released savepoints, and discards all effects', t => {
  const { storage, insert, values } = fixture(t), ran: string[] = [], failure = new Error('outer failure');
  assert.throws(() => storage.transaction(() => {
    storage.transaction(() => { insert('inner'); storage.afterCommit(() => ran.push('inner')); });
    insert('outer');
    storage.afterCommit(() => ran.push('outer'));
    throw failure;
  }), error => error === failure);
  assert.deepEqual(values(), []);
  assert.deepEqual(ran, []);
  assert.equal(storage.active, false);
  storage.transaction(() => insert('retry'));
  assert.deepEqual(values(), ['retry']);
});

test('after-commit effects run once, in scheduling order, after the data is durable', t => {
  const file = tempFile(t);
  const { storage, insert } = fixture(t, file);
  const observer = open(file, t), seen: unknown[] = [];
  const committed = () => observer.prepare('SELECT count(*) AS n FROM effects').get()!.n;
  storage.transaction(() => {
    insert('a');
    storage.afterCommit(() => seen.push(['first', committed()]));
    storage.transaction(() => {
      insert('b');
      storage.afterCommit(() => seen.push(['nested', committed()]));
    });
    storage.afterCommit(() => seen.push(['last', committed()]));
  });
  assert.deepEqual(seen, [['first', 2], ['nested', 2], ['last', 2]]);
  let immediate = false;
  storage.afterCommit(() => { immediate = true; });
  assert.equal(immediate, true, 'outside a transaction an effect runs at once');
});

test('an effect may open a new transaction; a failing effect does not stop the rest', t => {
  const { storage, insert, values } = fixture(t), ran: string[] = [], failure = new Error('effect failed');
  assert.throws(() => storage.transaction(() => {
    insert('first');
    storage.afterCommit(() => { throw failure; });
    storage.afterCommit(() => storage.transaction(() => {
      insert('from-effect');
      storage.afterCommit(() => ran.push('effect of effect'));
    }));
  }), error => error === failure);
  assert.deepEqual(values(), ['first', 'from-effect']);
  assert.deepEqual(ran, ['effect of effect']);
});

test('HiveBus bound to a Storage emits after commit and drops events of rolled-back work', t => {
  const { storage, insert } = fixture(t), bus = new HiveBus(), rooms: string[] = [];
  bus.bindStorage(storage);
  bus.on('room', ({ channelId }) => rooms.push(channelId));
  storage.transaction(() => {
    bus.emit('room', { channelId: 'kept' });
    assert.deepEqual(rooms, []);
    assert.throws(() => storage.transaction(() => { bus.emit('room', { channelId: 'dropped' }); throw new Error('x'); }));
    insert('row');
  });
  assert.deepEqual(rooms, ['kept']);
  bus.emit('room', { channelId: 'direct' });
  assert.deepEqual(rooms, ['kept', 'direct']);
});

test('the outermost write transaction takes the write lock up front across handles', t => {
  const file = tempFile(t);
  const { storage, insert } = fixture(t, file);
  const other = open(file, t);
  const otherCanWrite = () => {
    try { other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); return true; }
    catch (error) { assert.match(String(error), /locked|busy/i); return false; }
  };
  // Before any write statement the lock is already held: no deferred lock upgrade race.
  storage.transaction(() => assert.equal(otherCanWrite(), false));
  assert.equal(otherCanWrite(), true);
  // A read snapshot is DEFERRED, and nested calls follow the outermost choice.
  storage.transaction(() => {
    storage.transaction(() => assert.equal(otherCanWrite(), true));
  }, { immediate: false });
  // A second handle's Storage waits its turn instead of interleaving.
  const second = Storage.for(other);
  storage.transaction(() => {
    insert('holder');
    assert.throws(() => second.transaction(() => other.exec("INSERT INTO effects VALUES('racer')")), /locked|busy/i);
    assert.equal(second.active, false);
  });
  second.transaction(() => other.exec("INSERT INTO effects VALUES('after')"));
  assert.deepEqual(other.prepare('SELECT value FROM effects ORDER BY rowid').all().map(row => row.value), ['holder', 'after']);
});

test('a rejected BEGIN never rolls back a transaction opened outside Storage', t => {
  const { handle, storage, values } = fixture(t);
  handle.exec("BEGIN IMMEDIATE; INSERT INTO effects VALUES('caller-owned')");
  assert.throws(() => storage.transaction(() => assert.fail('body must not run')), /within a transaction/);
  assert.deepEqual(values(), ['caller-owned']);
  handle.exec('ROLLBACK');
});

test('asynchronous work is rejected and rolled back', t => {
  const { storage, insert, values } = fixture(t);
  assert.throws(() => storage.transaction(() => { insert('lost'); return Promise.resolve(); }), /must be synchronous/);
  assert.deepEqual(values(), []);
});

test('a late SQL ABORT rolls back all earlier writes and leaves the connection reusable', t => {
  const { handle, storage, values } = fixture(t);
  handle.exec(`CREATE TRIGGER fail_late BEFORE INSERT ON effects WHEN NEW.value = 'fail'
    BEGIN SELECT RAISE(ABORT, 'injected SQL abort'); END`);
  assert.throws(() => storage.transaction(() => {
    handle.exec("INSERT INTO effects VALUES('first'); INSERT INTO effects VALUES('fail')");
  }), /injected SQL abort/);
  assert.deepEqual(values(), []);
  storage.transaction(() => handle.exec("INSERT INTO effects VALUES('retry')"));
  assert.deepEqual(values(), ['retry']);
});

test('SQLite auto-rollback inside a savepoint poisons the outer unit of work instead of autocommitting', t => {
  const { handle, storage, insert, values } = fixture(t), ran: string[] = [];
  handle.exec(`CREATE TRIGGER fail_rollback BEFORE INSERT ON effects WHEN NEW.value = 'fail'
    BEGIN SELECT RAISE(ROLLBACK, 'injected SQL rollback'); END`);
  assert.throws(() => storage.transaction(() => {
    insert('outer');
    storage.afterCommit(() => ran.push('outer'));
    assert.throws(() => storage.transaction(() => insert('fail')), /injected SQL rollback/);
    // The whole transaction is gone; a new savepoint would silently start a fresh one.
    storage.transaction(() => insert('would autocommit'));
  }), /rolled back by SQLite/);
  assert.deepEqual(values(), []);
  assert.deepEqual(ran, []);
  storage.transaction(() => insert('retry'));
  assert.deepEqual(values(), ['retry']);
});

test('a deferred constraint failure at COMMIT rolls back and discards effects', t => {
  const { handle, storage } = fixture(t), ran: string[] = [];
  handle.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`);
  handle.exec('PRAGMA foreign_keys = ON');
  assert.throws(() => storage.transaction(() => {
    handle.exec('INSERT INTO child VALUES(7)');
    storage.afterCommit(() => ran.push('never'));
  }), /FOREIGN KEY/);
  assert.equal(handle.prepare('SELECT count(*) AS n FROM child').get()!.n, 0);
  assert.deepEqual(ran, []);
  storage.transaction(() => handle.exec('INSERT INTO parent VALUES(7); INSERT INTO child VALUES(7)'));
  assert.equal(handle.prepare('SELECT count(*) AS n FROM child').get()!.n, 1);
});

test('Storage never consults the runtime-version-dependent isTransaction property', t => {
  const handle = new DatabaseSync(':memory:');
  t.after(() => handle.close());
  handle.exec('CREATE TABLE effects(value TEXT NOT NULL)');
  // Some supported runtimes expose a non-configurable own getter. A proxy
  // guards reads without redefining it, while exec still uses the real DB.
  const guarded = new Proxy(handle, {
    get(target, property) {
      if (property === 'isTransaction') assert.fail('isTransaction must not be read');
      if (property === 'exec') return target.exec.bind(target);
      return Reflect.get(target, property, target);
    },
  });
  const storage = Storage.for(guarded), failure = new Error('original failure');
  assert.throws(() => storage.transaction(() => {
    storage.transaction(() => handle.exec("INSERT INTO effects VALUES('temporary')"));
    throw failure;
  }), error => error === failure);
  assert.equal(handle.prepare('SELECT count(*) AS n FROM effects').get()!.n, 0);
});

test('Hive modules share one unit of work: formerly top-level-only writes nest, and events wait for the commit', t => {
  const file = tempFile(t), hive = new Hive(file);
  t.after(() => hive.db.close());
  assert.equal(hive.storage, Storage.for(hive.db));
  const human = hive.identity.getAgent('human'), worker = hive.identity.join({ role: 'worker', seniority: 'mid' }).agent;
  const dm = hive.channels.openDm(human, worker.name), seen: string[] = [];
  const onMessage = (message: Message) => seen.push(message.body);
  hive.bus.on('message', onMessage);
  t.after(() => hive.bus.off('message', onMessage));
  const session = randomUUID();
  assert.throws(() => hive.storage.transaction(() => {
    hive.delivery.openInboxSession(worker, session); // InboxDeliveryStore used its own BEGIN IMMEDIATE before #168
    hive.messages.postMessage(human, { channel: dm.id, body: 'rolled back' });
    throw new Error('abort');
  }), /abort/);
  assert.deepEqual(seen, []);
  assert.equal(hasRow(hive, 'inbox_sessions', { session_id: session }), false);
  hive.storage.transaction(() => {
    hive.delivery.openInboxSession(worker, session);
    hive.messages.postMessage(human, { channel: dm.id, body: 'kept' });
    assert.deepEqual(seen, [], 'no event before the outer commit');
  });
  assert.deepEqual(seen, ['kept']);
  assert.equal(hasRow(hive, 'inbox_sessions', { session_id: session }), true);
});
