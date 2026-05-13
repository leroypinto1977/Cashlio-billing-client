import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cashlio-terminal.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `)
  const row = d.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  const current = row?.version ?? 0

  if (current < 1) {
    d.exec(`
      CREATE TABLE pending_bills (
        client_local_id TEXT PRIMARY KEY,
        payload_json    TEXT    NOT NULL,
        display_json    TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        last_attempt_at INTEGER,
        status          TEXT    NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX idx_pending_status_created
        ON pending_bills(status, created_at);

      CREATE TABLE product_cache (
        id            TEXT PRIMARY KEY,
        item_code     TEXT,
        name          TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_product_cache_item_code ON product_cache(item_code);
      CREATE INDEX idx_product_cache_name ON product_cache(name);

      CREATE TABLE sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `)
    d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
  }

  if (current < 2) {
    // Phase 3D: full local mirror of products and customers, populated by
    // the pull-sync worker. `product_cache` (from v1) is now legacy and
    // ignored — we keep it around so older builds don't crash.
    d.exec(`
      CREATE TABLE products (
        id              TEXT PRIMARY KEY,
        item_code       TEXT,
        name            TEXT NOT NULL,
        is_active       INTEGER NOT NULL DEFAULT 1,
        total_stock     INTEGER NOT NULL DEFAULT 0,
        payload_json    TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_products_item_code ON products(item_code);
      CREATE INDEX idx_products_name ON products(name);

      CREATE TABLE customers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        phone         TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        payload_json  TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_customers_phone ON customers(phone);
      CREATE INDEX idx_customers_name ON customers(name);

      CREATE TABLE bills_seen (
        id           TEXT PRIMARY KEY,
        bill_number  TEXT,
        status       TEXT,
        payload_json TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `)
    d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2)
  }
}

// ─── Pending bills ──────────────────────────────────────────────────────────

export type PendingBillRow = {
  clientLocalId: string
  payload: unknown
  display: unknown
  createdAt: number
  attempts: number
  lastError: string | null
  status: string
}

export function enqueuePendingBill(input: {
  clientLocalId: string
  payload: unknown
  display: unknown
}): void {
  const d = getDb()
  d.prepare(
    `INSERT OR IGNORE INTO pending_bills
       (client_local_id, payload_json, display_json, created_at, status)
     VALUES (?, ?, ?, ?, 'pending')`
  ).run(
    input.clientLocalId,
    JSON.stringify(input.payload),
    JSON.stringify(input.display),
    Date.now()
  )
}

export function listPendingBills(): PendingBillRow[] {
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT client_local_id, payload_json, display_json, created_at,
              attempts, last_error, status
         FROM pending_bills
         WHERE status = 'pending'
         ORDER BY created_at ASC`
    )
    .all() as Array<{
    client_local_id: string
    payload_json: string
    display_json: string
    created_at: number
    attempts: number
    last_error: string | null
    status: string
  }>
  return rows.map((r) => ({
    clientLocalId: r.client_local_id,
    payload: safeParse(r.payload_json),
    display: safeParse(r.display_json),
    createdAt: r.created_at,
    attempts: r.attempts,
    lastError: r.last_error,
    status: r.status
  }))
}

export function countPendingBills(): number {
  const d = getDb()
  const r = d
    .prepare(`SELECT COUNT(*) AS c FROM pending_bills WHERE status = 'pending'`)
    .get() as { c: number }
  return r.c
}

export function removePendingBill(clientLocalId: string): void {
  const d = getDb()
  d.prepare(`DELETE FROM pending_bills WHERE client_local_id = ?`).run(clientLocalId)
}

export function markPendingBillAttempted(input: {
  clientLocalId: string
  error: string | null
}): void {
  const d = getDb()
  d.prepare(
    `UPDATE pending_bills
        SET attempts = attempts + 1,
            last_error = ?,
            last_attempt_at = ?
      WHERE client_local_id = ?`
  ).run(input.error, Date.now(), input.clientLocalId)
}

export function markPendingBillFailedPermanent(input: {
  clientLocalId: string
  error: string
}): void {
  const d = getDb()
  d.prepare(
    `UPDATE pending_bills
        SET status = 'failed_permanent',
            last_error = ?,
            last_attempt_at = ?
      WHERE client_local_id = ?`
  ).run(input.error, Date.now(), input.clientLocalId)
}

// ─── Product cache ──────────────────────────────────────────────────────────

export type ProductCacheRow = {
  id: string
  itemCode: string | null
  name: string
  payload: unknown
  updatedAt: number
}

export function replaceProductCache(products: Array<Record<string, unknown>>): void {
  const d = getDb()
  const now = Date.now()
  const tx = d.transaction((items: Array<Record<string, unknown>>) => {
    d.prepare(`DELETE FROM product_cache`).run()
    const ins = d.prepare(
      `INSERT INTO product_cache (id, item_code, name, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const p of items) {
      const id = String(p.id ?? '')
      if (!id) continue
      ins.run(id, asString(p.itemCode), asString(p.name) ?? '', JSON.stringify(p), now)
    }
  })
  tx(products)
}

export function searchProductCache(query: string, limit = 20): unknown[] {
  const d = getDb()
  const q = `%${query.toLowerCase()}%`
  const rows = d
    .prepare(
      `SELECT payload_json FROM product_cache
        WHERE LOWER(name) LIKE ? OR LOWER(item_code) LIKE ?
        LIMIT ?`
    )
    .all(q, q, limit) as Array<{ payload_json: string }>
  return rows.map((r) => safeParse(r.payload_json))
}

export function getProductCacheUpdatedAt(): number | null {
  const d = getDb()
  const r = d
    .prepare(`SELECT MAX(updated_at) AS ts FROM product_cache`)
    .get() as { ts: number | null }
  return r.ts ?? null
}

// ─── Product mirror (Phase 3D) ──────────────────────────────────────────────

export function searchProducts(query: string, limit = 20): unknown[] {
  const d = getDb()
  const q = `%${query.toLowerCase()}%`
  const rows = d
    .prepare(
      `SELECT payload_json FROM products
        WHERE is_active = 1
          AND (LOWER(name) LIKE ? OR LOWER(item_code) LIKE ?)
        ORDER BY name ASC
        LIMIT ?`
    )
    .all(q, q, limit) as Array<{ payload_json: string }>
  return rows.map((r) => safeParse(r.payload_json))
}

export function getProductByItemCode(itemCode: string): unknown | null {
  const d = getDb()
  const r = d
    .prepare(
      `SELECT payload_json FROM products
        WHERE item_code = ? AND is_active = 1
        LIMIT 1`
    )
    .get(itemCode) as { payload_json: string } | undefined
  return r ? safeParse(r.payload_json) : null
}

export function countProductMirror(): number {
  const d = getDb()
  const r = d.prepare(`SELECT COUNT(*) AS c FROM products`).get() as { c: number }
  return r.c
}

// ─── Customer mirror (Phase 3D) ─────────────────────────────────────────────

export function searchCustomers(query: string, limit = 20): unknown[] {
  const d = getDb()
  const q = `%${query.toLowerCase()}%`
  const rows = d
    .prepare(
      `SELECT payload_json FROM customers
        WHERE is_active = 1
          AND (LOWER(name) LIKE ? OR phone LIKE ?)
        ORDER BY name ASC
        LIMIT ?`
    )
    .all(q, q, limit) as Array<{ payload_json: string }>
  return rows.map((r) => safeParse(r.payload_json))
}

// ─── Sync events (Phase 3D pull) ────────────────────────────────────────────

export type SyncEventInput = {
  id: string
  entity: 'product' | 'customer' | 'bill' | string
  entityId: string
  op: 'upsert' | 'delete' | string
  payload: unknown
}

/**
 * Apply a batch of pulled events atomically. Returns the highest id seen so
 * the caller can persist a cursor only after the batch commits.
 */
export function applySyncEvents(events: SyncEventInput[]): { applied: number; lastId: string | null } {
  if (events.length === 0) return { applied: 0, lastId: null }
  const d = getDb()
  const upsertProduct = d.prepare(
    `INSERT INTO products (id, item_code, name, is_active, total_stock, payload_json, updated_at)
     VALUES (@id, @itemCode, @name, @isActive, @totalStock, @payload, @ts)
     ON CONFLICT(id) DO UPDATE SET
       item_code = excluded.item_code,
       name = excluded.name,
       is_active = excluded.is_active,
       total_stock = excluded.total_stock,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`
  )
  const deleteProduct = d.prepare(`DELETE FROM products WHERE id = ?`)
  const upsertCustomer = d.prepare(
    `INSERT INTO customers (id, name, phone, is_active, payload_json, updated_at)
     VALUES (@id, @name, @phone, @isActive, @payload, @ts)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       is_active = excluded.is_active,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`
  )
  const deleteCustomer = d.prepare(`DELETE FROM customers WHERE id = ?`)
  const upsertBill = d.prepare(
    `INSERT INTO bills_seen (id, bill_number, status, payload_json, updated_at)
     VALUES (@id, @billNumber, @status, @payload, @ts)
     ON CONFLICT(id) DO UPDATE SET
       bill_number = excluded.bill_number,
       status = excluded.status,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`
  )

  let applied = 0
  let lastId: string | null = null

  const tx = d.transaction((batch: SyncEventInput[]) => {
    for (const ev of batch) {
      lastId = ev.id
      try {
        if (ev.entity === 'product') {
          if (ev.op === 'delete') {
            deleteProduct.run(ev.entityId)
          } else {
            const p = (ev.payload ?? {}) as Record<string, unknown>
            upsertProduct.run({
              id: ev.entityId,
              itemCode: asString(p.itemCode),
              name: asString(p.name) ?? '',
              isActive: p.isActive === false ? 0 : 1,
              totalStock: Number(p.totalStock ?? 0) | 0,
              payload: JSON.stringify(p),
              ts: Date.now()
            })
          }
        } else if (ev.entity === 'customer') {
          if (ev.op === 'delete') {
            deleteCustomer.run(ev.entityId)
          } else {
            const c = (ev.payload ?? {}) as Record<string, unknown>
            upsertCustomer.run({
              id: ev.entityId,
              name: asString(c.name) ?? '',
              phone: asString(c.phone),
              isActive: c.isActive === false ? 0 : 1,
              payload: JSON.stringify(c),
              ts: Date.now()
            })
          }
        } else if (ev.entity === 'bill') {
          if (ev.op === 'delete') {
            d.prepare(`DELETE FROM bills_seen WHERE id = ?`).run(ev.entityId)
          } else {
            const b = (ev.payload ?? {}) as Record<string, unknown>
            upsertBill.run({
              id: ev.entityId,
              billNumber: asString(b.billNumber),
              status: asString(b.status),
              payload: JSON.stringify(b),
              ts: Date.now()
            })
          }
        }
        // Unknown entity types are silently skipped — forward-compat with
        // future server versions emitting events the terminal doesn't know.
        applied++
      } catch (e) {
        console.warn('[sync] failed to apply event', ev.id, ev.entity, ev.op, e)
      }
    }
  })
  tx(events)
  return { applied, lastId }
}

// ─── Sync state (key/value) ─────────────────────────────────────────────────

export function getSyncState(key: string): string | null {
  const d = getDb()
  const r = d.prepare(`SELECT value FROM sync_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return r?.value ?? null
}

export function setSyncState(key: string, value: string): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

/** Read the next bill number this terminal would mint, without incrementing. */
export function peekLocalBillNumber(prefix: string): string {
  if (!prefix) return ''
  const d = getDb()
  const row = d.prepare(`SELECT value FROM sync_state WHERE key = 'bill_seq'`).get() as
    | { value: string }
    | undefined
  const cur = row ? parseInt(row.value, 10) || 0 : 0
  return `${prefix}-${String(cur + 1).padStart(5, '0')}`
}

/**
 * Mint the next bill number for this terminal. Format: `<prefix>-<seq>` where
 * seq is a zero-padded, terminal-local counter. The increment is atomic so
 * two windows of the same terminal can't collide.
 */
export function nextLocalBillNumber(prefix: string): string {
  if (!prefix) throw new Error('terminal_prefix_required')
  const d = getDb()
  const next = d.transaction(() => {
    const row = d.prepare(`SELECT value FROM sync_state WHERE key = 'bill_seq'`).get() as
      | { value: string }
      | undefined
    const cur = row ? parseInt(row.value, 10) || 0 : 0
    const n = cur + 1
    d.prepare(
      `INSERT INTO sync_state (key, value) VALUES ('bill_seq', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(n))
    return n
  })()
  return `${prefix}-${String(next).padStart(5, '0')}`
}

// ─── helpers ────────────────────────────────────────────────────────────────

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function asString(v: unknown): string | null {
  if (v == null) return null
  return String(v)
}
