import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import os from 'os'
import icon from '../../resources/icon.png?asset'
import {
  getDb,
  enqueuePendingBill,
  listPendingBills,
  listFailedBills,
  countFailedBills,
  retryFailedBill,
  countPendingBills,
  removePendingBill,
  markPendingBillAttempted,
  markPendingBillFailedPermanent,
  replaceProductCache,
  searchProductCache,
  getProductCacheUpdatedAt,
  searchProducts,
  getProductByItemCode,
  getProductByBarcode,
  countProductMirror,
  searchCustomers,
  applySyncEvents,
  getSyncState,
  setSyncState,
  nextLocalBillNumber,
  peekLocalBillNumber
} from './db'
import type { SyncEventInput } from './db'
import { appendFileSync } from 'fs'
import tls from 'tls'
import {
  getPinnedFingerprint,
  setPinnedFingerprint,
  clearPinnedFingerprint,
  fingerprintsMatch,
  fingerprintOfPem
} from './pinnedCert'

function getMacAddress(): string {
  const interfaces = os.networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac
      }
    }
  }
  return 'UNKNOWN-MAC'
}

// A rejected promise in the main process terminates Electron under Node 20+.
// On a till that means the app disappears mid-sale, taking the offline outbox
// worker with it, and leaves nothing behind explaining why.
function logCrash(kind: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${kind}: ${
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  }\n`
  console.error(line)
  try {
    appendFileSync(join(app.getPath('userData'), 'crash.log'), line)
  } catch {
    // Logging must never be the thing that brings the till down.
  }
}
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))
process.on('uncaughtException', (err) => logCrash('uncaughtException', err))

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand real web links to the OS. Unfiltered, this would open
    // file:// and smb:// URLs and any registered protocol handler.
    try {
      const { protocol } = new URL(details.url)
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Not a URL we can parse; refuse it.
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
/**
 * Accept the branch server's certificate, and only that one.
 *
 * The server issues its own — there is no certificate authority in a shop —
 * so Chromium refuses it by default. The till was told the fingerprint at
 * pairing, and this is where that promise is kept: exactly that certificate,
 * on the LAN, and nothing else. An unpaired till pins nothing and so trusts
 * nothing, which is the right way round.
 */
app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  const pinned = getPinnedFingerprint(app.getPath('userData'))
  const presented = fingerprintOfPem(certificate.data)
  if (pinned && presented && fingerprintsMatch(presented, pinned)) {
    event.preventDefault()
    callback(true)
    return
  }
  // Say which it was. "Could not connect" sends a shop hunting the network
  // when the answer is that this till is pointed at a different machine.
  console.error(
    `[tls] refusing ${url} — ${pinned ? 'certificate does not match the one pinned at pairing' : 'this terminal has not been paired'}`
  )
  callback(false)
})

app.whenReady().then(() => {
  // Set app user model id for windows
  app.setAppUserModelId('com.cashlio.terminal')

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Expose real MAC address to renderer securely via IPC
  ipcMain.handle('get-mac-address', () => getMacAddress())

  // Pairing hands the till the branch server's certificate fingerprint. It is
  // written here, in the main process, because the check that uses it runs
  // here — a value the page could rewrite would not be a pin at all.
  ipcMain.handle('tls:pin', (_e, fingerprint: string) => {
    const ok = setPinnedFingerprint(app.getPath('userData'), String(fingerprint ?? ''))
    return { ok }
  })
  ipcMain.handle('tls:pinned', () => getPinnedFingerprint(app.getPath('userData')))

  /**
   * Look at what a branch server is presenting, without trusting it.
   *
   * An unpaired till has nothing pinned, so it trusts nothing — which leaves
   * it unable to make the very request that would get it paired. This is the
   * way out: open the connection, read the certificate, send nothing. What
   * comes back is shown to the manager to check against the fingerprint on
   * the manager app before anything is pinned or any password is typed. That
   * comparison is the security here — accepting whatever answers first would
   * hand the shop's credentials to anything on the network that got in ahead
   * of the real server.
   */
  ipcMain.handle('tls:inspect', async (_e, input: { host: string; port: number }) => {
    return new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: input.host,
          port: Number(input.port),
          servername: input.host,
          rejectUnauthorized: false,
          timeout: 6000
        },
        () => {
          const cert = socket.getPeerX509Certificate?.()
          socket.destroy()
          resolve(
            cert
              ? {
                  ok: true,
                  fingerprint: cert.fingerprint256,
                  subject: cert.subject,
                  validTo: cert.validTo
                }
              : { ok: false, error: 'NO_CERTIFICATE' }
          )
        }
      )
      socket.on('error', (e: Error) => resolve({ ok: false, error: e.message }))
      socket.on('timeout', () => {
        socket.destroy()
        resolve({ ok: false, error: 'TIMEOUT' })
      })
    })
  })
  ipcMain.handle('tls:unpin', () => {
    clearPinnedFingerprint(app.getPath('userData'))
    return { ok: true }
  })

  // ─── Local SQLite ───────────────────────────────────────────────────────
  // Open the DB on startup so failures surface early and migrations run
  // before any IPC call hits.
  try {
    getDb()
  } catch (e) {
    console.error('[db] failed to open SQLite:', e)
  }

  // Pending bills (offline outbox)
  ipcMain.handle(
    'db:bill:enqueue',
    (_e, input: { clientLocalId: string; payload: unknown; display: unknown }) => {
      enqueuePendingBill(input)
      return { ok: true, count: countPendingBills() }
    }
  )
  ipcMain.handle('db:bill:list-pending', () => listPendingBills())
  ipcMain.handle('db:bill:count-pending', () => countPendingBills())
  ipcMain.handle('db:bill:list-failed', () => listFailedBills())
  ipcMain.handle('db:bill:count-failed', () => countFailedBills())
  ipcMain.handle('db:bill:retry-failed', (_e, clientLocalId: string) => {
    retryFailedBill(clientLocalId)
    return { ok: true, pending: countPendingBills(), failed: countFailedBills() }
  })
  ipcMain.handle('db:bill:remove', (_e, clientLocalId: string) => {
    removePendingBill(clientLocalId)
    return { ok: true, count: countPendingBills() }
  })
  ipcMain.handle(
    'db:bill:mark-attempted',
    (_e, input: { clientLocalId: string; error: string | null }) => {
      markPendingBillAttempted(input)
      return { ok: true }
    }
  )
  ipcMain.handle(
    'db:bill:mark-failed',
    (_e, input: { clientLocalId: string; error: string }) => {
      markPendingBillFailedPermanent(input)
      return { ok: true, count: countPendingBills() }
    }
  )

  // Product cache
  ipcMain.handle(
    'db:product:replace-cache',
    (_e, products: Array<Record<string, unknown>>) => {
      replaceProductCache(products)
      return { ok: true, count: products.length, updatedAt: Date.now() }
    }
  )
  ipcMain.handle(
    'db:product:search',
    (_e, input: { query: string; limit?: number }) =>
      searchProductCache(input.query, input.limit ?? 20)
  )
  ipcMain.handle('db:product:cache-updated-at', () => getProductCacheUpdatedAt())

  // Local mirror (Phase 3D)
  ipcMain.handle(
    'db:mirror:product-search',
    (_e, input: { query: string; limit?: number }) =>
      searchProducts(input.query, input.limit ?? 20)
  )
  ipcMain.handle('db:mirror:product-by-item-code', (_e, itemCode: string) =>
    getProductByItemCode(itemCode)
  )
  ipcMain.handle('db:mirror:product-by-barcode', (_e, code: string) =>
    getProductByBarcode(code)
  )
  ipcMain.handle('db:mirror:product-count', () => countProductMirror())
  ipcMain.handle(
    'db:mirror:customer-search',
    (_e, input: { query: string; limit?: number }) =>
      searchCustomers(input.query, input.limit ?? 20)
  )
  ipcMain.handle('db:sync:apply-events', (_e, events: SyncEventInput[]) =>
    applySyncEvents(events)
  )

  // Terminal-side bill number minter (Phase 3D)
  ipcMain.handle('db:terminal:next-bill-number', (_e, prefix: string) =>
    nextLocalBillNumber(prefix)
  )
  ipcMain.handle('db:terminal:peek-bill-number', (_e, prefix: string) =>
    peekLocalBillNumber(prefix)
  )

  // Sync state (key/value)
  ipcMain.handle('db:sync:get', (_e, key: string) => getSyncState(key))
  ipcMain.handle('db:sync:set', (_e, input: { key: string; value: string }) => {
    setSyncState(input.key, input.value)
    return { ok: true }
  })

  // Print a receipt: renderer hands us the full HTML, we render it in a
  // hidden BrowserWindow and trigger printing. silent:false opens the OS
  // print dialog; pass deviceName via localStorage→arg in the future for
  // truly silent printing once a default printer is configured.
  ipcMain.handle('print-receipt', async (_evt, payload: { html: string; billNumber?: string; deviceName?: string }) => {
    const html = payload?.html ?? ''
    if (!html) return { ok: false, error: 'NO_HTML' }
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    try {
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
      await printWin.loadURL(dataUrl)
      await new Promise<void>((resolve, reject) => {
        printWin.webContents.print(
          {
            silent: !!payload?.deviceName,
            deviceName: payload?.deviceName,
            printBackground: true,
            margins: { marginType: 'none' }
          },
          (success, failureReason) => {
            if (success) resolve()
            else reject(new Error(failureReason || 'PRINT_CANCELLED'))
          }
        )
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      if (!printWin.isDestroyed()) printWin.close()
    }
  })

  // Override CSP from the main process so LAN HTTP requests to the branch server are allowed.
  // The HTML meta-tag CSP cannot reliably wildcard arbitrary IPs in Chromium.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http://localhost:* ws://localhost:* ws://127.0.0.1:*; img-src 'self' data:"
        ]
      }
    })
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
