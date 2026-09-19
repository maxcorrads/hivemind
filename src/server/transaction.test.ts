import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from './transaction.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE effects(value TEXT NOT NULL)');
  const values = () => db.prepare('SELECT value FROM effects ORDER BY rowid').all().map(row => row.value);
  return { db, values };
}

test('the shared transaction commits before returning its exact result', t => {
  const { db, values } = fixture(t), result = { committed: true };
  assert.equal(immediateTransaction(db, () => {
    db.prepare('INSERT INTO effects VALUES(?)').run('saved');
    return result;
  }), result);
  assert.deepEqual(values(), ['saved']);
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
});

test('a failed transaction rolls back and preserves the original exception on Node 22.13', t => {
  const { db, values } = fixture(t), failure = new Error('injected after write');
  assert.throws(() => immediateTransaction(db, () => {
    db.prepare('INSERT INTO effects VALUES(?)').run('not committed');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(values(), []);
  immediateTransaction(db, () => db.prepare('INSERT INTO effects VALUES(?)').run('retry'));
  assert.deepEqual(values(), ['retry']);
});

test('a rejected nested BEGIN never rolls back its caller transaction', t => {
  const { db, values } = fixture(t);
  db.exec("BEGIN IMMEDIATE; INSERT INTO effects VALUES('caller-owned')");
  assert.throws(() => immediateTransaction(db, () => assert.fail('nested body must not run')), /within a transaction/);
  assert.deepEqual(values(), ['caller-owned']);
  db.exec('ROLLBACK');
  assert.deepEqual(values(), []);
});

test('a late SQL ABORT rolls back all earlier writes and leaves the connection reusable', t => {
  const { db, values } = fixture(t);
  db.exec(`CREATE TRIGGER fail_late BEFORE INSERT ON effects WHEN NEW.value = 'fail'
    BEGIN SELECT RAISE(ABORT, 'injected SQL abort'); END`);
  assert.throws(() => immediateTransaction(db, () => {
    db.exec("INSERT INTO effects VALUES('first'); INSERT INTO effects VALUES('fail')");
  }), /injected SQL abort/);
  assert.deepEqual(values(), []);
  immediateTransaction(db, () => db.exec("INSERT INTO effects VALUES('retry')"));
  assert.deepEqual(values(), ['retry']);
});

test('SQLite auto-rollback does not replace the original failure with a cleanup error', t => {
  const { db, values } = fixture(t);
  db.exec(`CREATE TRIGGER fail_rollback BEFORE INSERT ON effects WHEN NEW.value = 'fail'
    BEGIN SELECT RAISE(ROLLBACK, 'injected SQL rollback'); END`);
  assert.throws(() => immediateTransaction(db, () => {
    db.exec("INSERT INTO effects VALUES('first'); INSERT INTO effects VALUES('fail')");
  }), /injected SQL rollback/);
  assert.deepEqual(values(), []);
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
});

test('a deferred constraint failure at COMMIT rolls back the transaction', t => {
  const { db } = fixture(t);
  db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`);
  assert.throws(() => immediateTransaction(db, () => db.exec('INSERT INTO child VALUES(7)')), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()!.n, 0);
  immediateTransaction(db, () => db.exec('INSERT INTO parent VALUES(7); INSERT INTO child VALUES(7)'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()!.n, 1);
});

test('transaction cleanup never consults a runtime-version-dependent isTransaction property', t => {
  const { db, values } = fixture(t);
  // Some supported runtimes expose a non-configurable own getter. A proxy
  // guards reads without redefining it, while exec still uses the real DB.
  const guarded = new Proxy(db, {
    get(target, property) {
      if (property === 'isTransaction') assert.fail('isTransaction must not be read');
      if (property === 'exec') return target.exec.bind(target);
      return Reflect.get(target, property, target);
    },
  });
  const failure = new Error('original failure');
  assert.throws(() => immediateTransaction(guarded, () => {
    db.exec("INSERT INTO effects VALUES('temporary')");
    throw failure;
  }), error => error === failure);
  assert.deepEqual(values(), []);
});
