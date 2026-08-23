/**
 * Unit tests for the terminal's SQLite layer.
 *
 * This is the only place an offline sale exists between the cashier taking
 * the money and the branch server accepting the bill, so the outbox is worth
 * testing directly rather than only through the UI.
 *
 * db.ts is TypeScript and imports electron for the userData path, so we bundle
 * it to CJS and hand it a scratch directory instead of a real Electron app.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const assert = require('assert')
const esbuild = require('esbuild')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashlio-db-test-'))
// The bundle has to live inside the project so its `require('better-sqlite3')`
// resolves against our node_modules.
const buildDir = path.join(__dirname, '.build')
fs.mkdirSync(buildDir, { recursive: true })
const bundle = path.join(buildDir, 'db.bundle.cjs')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'db.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'better-sqlite3']
})

// Stand in for Electron: the module is only used for the userData path.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => tmp } }
  return origLoad.call(this, request, parent, isMain)
}

const db = require(bundle)

let pass = 0
let fail = 0
function t(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`, detail === undefined ? '' : detail)
  }
}
function eq(name, actual, expected) {
  t(name, actual === expected, `(${JSON.stringify(actual)} !== ${JSON.stringify(expected)})`)
}

function reset() {
  const d = db.getDb()
  for (const tbl of ['pending_bills', 'products', 'customers', 'bills_seen', 'product_cache', 'sync_state']) {
    try {
      d.exec(`DELETE FROM ${tbl}`)
    } catch {
      // table may not exist on older schema versions
    }
  }
}

console.log('\n— migrations —')
{
  const d = db.getDb()
  const v = d.prepare('SELECT MAX(version) AS v FROM schema_version').get().v
  t('schema is migrated past v1', v >= 2, v)
  t('opening twice returns the same handle', db.getDb() === d)
  const tables = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name)
  for (const need of ['pending_bills', 'product_cache', 'sync_state', 'products', 'customers', 'bills_seen']) {
    t(`table ${need} exists`, tables.includes(need), tables)
  }
}

console.log('\n— the outbox —')
{
  reset()
  const payload = { billNumber: 'T1-00001', items: [{ productId: 'p1', quantity: 2 }] }
  const display = { grandTotal: 236, paymentMethod: 'CASH', itemCount: 1 }
  db.enqueuePendingBill({ clientLocalId: 'local-1', payload, display })
  eq('one queued bill', db.countPendingBills(), 1)

  // The same sale submitted twice must not become two bills.
  db.enqueuePendingBill({ clientLocalId: 'local-1', payload, display })
  eq('re-enqueueing the same sale is a no-op', db.countPendingBills(), 1)

  const [row] = db.listPendingBills()
  eq('payload round-trips', JSON.stringify(row.payload), JSON.stringify(payload))
  eq('display round-trips', row.display.grandTotal, 236)
  eq('starts with no attempts', row.attempts, 0)
  eq('starts pending', row.status, 'pending')

  db.markPendingBillAttempted({ clientLocalId: 'local-1', error: 'NETWORK' })
  db.markPendingBillAttempted({ clientLocalId: 'local-1', error: 'NETWORK' })
  const after = db.listPendingBills()[0]
  eq('attempts accumulate', after.attempts, 2)
  eq('the last error is kept', after.lastError, 'NETWORK')
  t('a retried bill is still pending', db.countPendingBills() === 1)

  db.removePendingBill('local-1')
  eq('an accepted bill leaves the queue', db.countPendingBills(), 0)
}

console.log('\n— rejected sales stay visible —')
{
  reset()
  db.enqueuePendingBill({ clientLocalId: 'r1', payload: { a: 1 }, display: { grandTotal: 500 } })
  db.enqueuePendingBill({ clientLocalId: 'r2', payload: { a: 2 }, display: { grandTotal: 700 } })
  db.markPendingBillFailedPermanent({ clientLocalId: 'r1', error: 'INSUFFICIENT_STOCK (HTTP 400)' })

  eq('a rejected bill stops being retried', db.countPendingBills(), 1)
  eq('...and is counted as rejected', db.countFailedBills(), 1)
  t('...and is not in the retry list', !db.listPendingBills().some((b) => b.clientLocalId === 'r1'))

  const [f] = db.listFailedBills()
  eq('the rejected bill is readable', f.clientLocalId, 'r1')
  eq('the money is still legible', f.display.grandTotal, 500)
  eq("the server's reason survives", f.lastError, 'INSUFFICIENT_STOCK (HTTP 400)')

  db.retryFailedBill('r1')
  eq('retrying puts it back in the queue', db.countPendingBills(), 2)
  eq('...and out of the rejected list', db.countFailedBills(), 0)
  const back = db.listPendingBills().find((b) => b.clientLocalId === 'r1')
  eq('...with a fresh run of attempts', back.attempts, 0)
  eq('...and the stale error cleared', back.lastError, null)

  db.retryFailedBill('r2')
  eq('retrying a bill that never failed changes nothing', db.countPendingBills(), 2)
}

console.log('\n— terminal bill numbering —')
{
  reset()
  eq('peek starts at one', db.peekLocalBillNumber('T1'), 'T1-00001')
  eq('peeking does not consume', db.peekLocalBillNumber('T1'), 'T1-00001')
  eq('first number', db.nextLocalBillNumber('T1'), 'T1-00001')
  eq('second number', db.nextLocalBillNumber('T1'), 'T1-00002')
  eq('peek follows the counter', db.peekLocalBillNumber('T1'), 'T1-00003')

  const seen = new Set()
  for (let i = 0; i < 500; i++) seen.add(db.nextLocalBillNumber('T1'))
  eq('500 numbers, no repeats', seen.size, 500)
  eq('padding survives past 9999', db.nextLocalBillNumber('T1'), 'T1-00503')

  let threw = false
  try {
    db.nextLocalBillNumber('')
  } catch {
    threw = true
  }
  t('refuses to mint without a terminal prefix', threw)
}

console.log('\n— sync mirror —')
{
  reset()
  const res = db.applySyncEvents([
    { id: '1', entity: 'product', entityId: 'p1', op: 'upsert',
      payload: { itemCode: 'PIPE-01', name: 'Copper Pipe', sellMode: 'LENGTH', totalStock: 14.375 } },
    { id: '2', entity: 'customer', entityId: 'c1', op: 'upsert',
      payload: { name: 'Ravi Kumar', phone: '9000000001' } },
    { id: '3', entity: 'bill', entityId: 'b1', op: 'upsert',
      payload: { billNumber: 'INV-0001', status: 'PAID' } }
  ])
  eq('all three events applied', res.applied, 3)
  eq('cursor is the last id', res.lastId, '3')
  eq('an event without a cursor token falls back to its id', res.lastCursor, '3')
  eq('product is searchable by name', db.searchProducts('copper').length, 1)
  eq('product is findable by item code', db.getProductByItemCode('PIPE-01').itemCode, 'PIPE-01')
  eq('customer is searchable by phone', db.searchCustomers('900000').length, 1)

  // Fractional stock is the whole point of cut-to-length; truncating it here
  // would quietly lose the offcut.
  const d = db.getDb()
  eq('fractional stock is kept', d.prepare('SELECT total_stock AS s FROM products WHERE id = ?').get('p1').s, 14.375)

  db.applySyncEvents([
    { id: '4', entity: 'product', entityId: 'p1', op: 'upsert',
      payload: { itemCode: 'PIPE-01', name: 'Copper Pipe 15mm', sellMode: 'LENGTH', totalStock: 9 } }
  ])
  eq('an upsert replaces rather than duplicates', db.countProductMirror(), 1)
  eq('the newer name wins', db.getProductByItemCode('PIPE-01').name, 'Copper Pipe 15mm')

  db.applySyncEvents([{ id: '5', entity: 'product', entityId: 'p1', op: 'delete', payload: null }])
  eq('a delete removes it', db.countProductMirror(), 0)

  eq('an empty batch is a no-op', db.applySyncEvents([]).applied, 0)
  eq('an unknown entity is skipped, not fatal',
    db.applySyncEvents([{ id: '6', entity: 'coupon', entityId: 'x', op: 'upsert', payload: {} }]).applied, 1)
}

console.log('\n— a broken event must not be stepped over —')
{
  reset()
  const d = db.getDb()
  // Force one event to fail: make the product id column reject this row.
  // A cursor that advanced past it would lose the event permanently.
  d.exec(`CREATE TRIGGER poison BEFORE INSERT ON products
          WHEN NEW.id = 'poison'
          BEGIN SELECT RAISE(ABORT, 'poisoned'); END`)
  const res = db.applySyncEvents([
    { id: '10', cursor: '900:10', entity: 'product', entityId: 'ok1', op: 'upsert', payload: { itemCode: 'A', name: 'First' } },
    { id: '11', cursor: '900:11', entity: 'product', entityId: 'poison', op: 'upsert', payload: { itemCode: 'B', name: 'Bad' } },
    { id: '12', cursor: '901:12', entity: 'product', entityId: 'ok2', op: 'upsert', payload: { itemCode: 'C', name: 'Third' } }
  ])
  eq('only the events before the break applied', res.applied, 1)
  eq('the cursor stays on the last good event', res.lastId, '10')
  eq('...as a resume token too', res.lastCursor, '900:10')
  eq('the failing event is named', res.stoppedAt, '11')
  t('the reason is reported', typeof res.error === 'string' && res.error.length > 0, res.error)
  eq('nothing after the break was applied', db.getProductByItemCode('C'), null)

  // Once the cause is gone, the same batch replays cleanly from the cursor.
  d.exec('DROP TRIGGER poison')
  const again = db.applySyncEvents([
    { id: '11', entity: 'product', entityId: 'poison', op: 'upsert', payload: { itemCode: 'B', name: 'Bad' } },
    { id: '12', entity: 'product', entityId: 'ok2', op: 'upsert', payload: { itemCode: 'C', name: 'Third' } }
  ])
  eq('the replay catches up', again.applied, 2)
  eq('...and advances the cursor', again.lastId, '12')
  t('the event that was stuck is now stored', db.getProductByItemCode('B') !== null)
}

console.log('\n— sync cursor —')
{
  reset()
  eq('an unset key reads back null', db.getSyncState('pull_cursor'), null)
  db.setSyncState('pull_cursor', '42')
  eq('a cursor round-trips', db.getSyncState('pull_cursor'), '42')
  db.setSyncState('pull_cursor', '43')
  eq('a cursor overwrites', db.getSyncState('pull_cursor'), '43')
}

console.log(`\n${pass} passed, ${fail} failed`)
try {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(buildDir, { recursive: true, force: true })
} catch {
  // scratch dir; leaving it behind is not worth failing over
}
process.exit(fail === 0 ? 0 : 1)
