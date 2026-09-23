import type { DatabaseSync } from "node:sqlite";

// Schema inspection helpers shared by migrations and startup validation.

export type Column = { name: string; type: string; notnull: number; pk: number };

export function columns(db: DatabaseSync, table: string): Column[] {
  return db.prepare("SELECT name, type, [notnull], pk FROM pragma_table_info(?)").all(table) as Column[];
}

export function hasColumn(db: DatabaseSync, table: string, name: string): boolean {
  return columns(db, table).some(column => column.name === name);
}

export function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

export function requireShape(db: DatabaseSync, table: string, required: string[]): Column[] {
  const cols = columns(db, table);
  for (const name of required) {
    if (!cols.some(col => col.name === name)) throw new Error(`Invalid storage schema: ${table}.${name} is missing`);
  }
  return cols;
}

export function primaryKey(cols: Column[]): string {
  return cols.filter(col => col.pk > 0).sort((a, b) => a.pk - b.pk).map(col => col.name).join(",");
}

export function requireKey(cols: Column[], table: string, allowed: string[]): void {
  if (!allowed.includes(primaryKey(cols))) throw new Error(`Invalid storage schema: ${table} primary key`);
}

export function hasUniqueKey(db: DatabaseSync, table: string, names: string[]): boolean {
  const indexes = db.prepare("SELECT name FROM pragma_index_list(?) WHERE [unique] = 1 AND partial = 0").all(table) as { name: string }[];
  return indexes.some(({ name }) => {
    const cols = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as { name: string | null }[];
    return cols.length === names.length && cols.every((col, i) => col.name === names[i]);
  });
}

/**
 * Rebuilds `table` with a new definition through a staging table, refusing to
 * adopt a leftover staging table and verifying that every row was copied.
 */
export function rebuild(db: DatabaseSync, table: string, definition: string, selection: string): void {
  const staging = `_hive_migrate_${table}`;
  // Do not silently adopt or erase a leftover/foreign staging table.
  db.exec(`CREATE TABLE ${staging} (${definition})`);
  db.exec(`INSERT INTO ${staging} SELECT ${selection} FROM ${table}`);
  const count = (name: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  if (count(staging) !== count(table)) throw new Error(`Migration row-count mismatch: ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${staging} RENAME TO ${table}`);
}
