import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import os from 'os'
import icon from '../../resources/icon.png?asset'
import {
  getDb,
  enqueuePendingBill,
  listPendingBills,
  countPendingBills,
  removePendingBill,
  markPendingBillAttempted,
  markPendingBillFailedPermanent,
  replaceProductCache,
  searchProductCache,
  getProductCacheUpdatedAt,
  searchProducts,
  getProductByItemCode,
  countProductMirror,
  searchCustomers,
  applySyncEvents,
  getSyncState,
  setSyncState,
  nextLocalBillNumber,
  peekLocalBillNumber
} from './db'
import type { SyncEventInput } from './db'

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
    shell.openExternal(details.url)
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
app.whenReady().then(() => {
  // Set app user model id for windows
  app.setAppUserModelId('com.electron')

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Expose real MAC address to renderer securely via IPC
  ipcMain.handle('get-mac-address', () => getMacAddress())

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
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http:; img-src 'self' data:"
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
