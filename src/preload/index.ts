import { contextBridge, ipcRenderer } from 'electron'

const db = {
  bill: {
    enqueue: (input: { clientLocalId: string; payload: unknown; display: unknown }) =>
      ipcRenderer.invoke('db:bill:enqueue', input) as Promise<{ ok: true; count: number }>,
    listPending: () => ipcRenderer.invoke('db:bill:list-pending') as Promise<
      Array<{
        clientLocalId: string
        payload: unknown
        display: unknown
        createdAt: number
        attempts: number
        lastError: string | null
        status: string
      }>
    >,
    countPending: () => ipcRenderer.invoke('db:bill:count-pending') as Promise<number>,
    listFailed: () =>
      ipcRenderer.invoke('db:bill:list-failed') as Promise<
        Array<{
          clientLocalId: string
          payload: unknown
          display: unknown
          createdAt: number
          attempts: number
          lastError: string | null
          status: string
        }>
      >,
    countFailed: () => ipcRenderer.invoke('db:bill:count-failed') as Promise<number>,
    retryFailed: (clientLocalId: string) =>
      ipcRenderer.invoke('db:bill:retry-failed', clientLocalId) as Promise<{
        ok: true
        pending: number
        failed: number
      }>,
    remove: (clientLocalId: string) =>
      ipcRenderer.invoke('db:bill:remove', clientLocalId) as Promise<{
        ok: true
        count: number
      }>,
    markAttempted: (input: { clientLocalId: string; error: string | null }) =>
      ipcRenderer.invoke('db:bill:mark-attempted', input) as Promise<{ ok: true }>,
    markFailed: (input: { clientLocalId: string; error: string }) =>
      ipcRenderer.invoke('db:bill:mark-failed', input) as Promise<{
        ok: true
        count: number
      }>
  },
  product: {
    replaceCache: (products: Array<Record<string, unknown>>) =>
      ipcRenderer.invoke('db:product:replace-cache', products) as Promise<{
        ok: true
        count: number
        updatedAt: number
      }>,
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke('db:product:search', { query, limit }) as Promise<unknown[]>,
    cacheUpdatedAt: () =>
      ipcRenderer.invoke('db:product:cache-updated-at') as Promise<number | null>
  },
  mirror: {
    productSearch: (query: string, limit?: number) =>
      ipcRenderer.invoke('db:mirror:product-search', { query, limit }) as Promise<unknown[]>,
    productByItemCode: (itemCode: string) =>
      ipcRenderer.invoke('db:mirror:product-by-item-code', itemCode) as Promise<unknown | null>,
    productCount: () =>
      ipcRenderer.invoke('db:mirror:product-count') as Promise<number>,
    customerSearch: (query: string, limit?: number) =>
      ipcRenderer.invoke('db:mirror:customer-search', { query, limit }) as Promise<unknown[]>
  },
  terminal: {
    nextBillNumber: (prefix: string) =>
      ipcRenderer.invoke('db:terminal:next-bill-number', prefix) as Promise<string>,
    peekBillNumber: (prefix: string) =>
      ipcRenderer.invoke('db:terminal:peek-bill-number', prefix) as Promise<string>
  },
  sync: {
    applyEvents: (events: unknown[]) =>
      ipcRenderer.invoke('db:sync:apply-events', events) as Promise<{
        applied: number
        lastId: string | null
        lastCursor: string | null
        stoppedAt: string | null
        error: string | null
      }>,
    get: (key: string) => ipcRenderer.invoke('db:sync:get', key) as Promise<string | null>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke('db:sync:set', { key, value }) as Promise<{ ok: true }>
  }
}

const api = {
  getMacAddress: () => ipcRenderer.invoke('get-mac-address'),
  db
}

/**
 * The renderer reaches the main process only through channels named here.
 *
 * A blanket `invoke` passes whatever string the page hands it, which turns
 * every handler the main process registers — including the ones that write to
 * the local database — into part of the page's attack surface. The renderer
 * shows names, notes and product descriptions typed by other people; keeping
 * this list explicit means a script that got in could still only call things
 * we chose to expose.
 */
const INVOKE_CHANNELS = ['get-mac-address', 'print-receipt'] as const

const electronStub = {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
        return Promise.reject(new Error(`IPC channel not exposed: ${channel}`))
      }
      return ipcRenderer.invoke(channel, ...args)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronStub)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronStub
  // @ts-ignore (define in dts)
  window.api = api
}
