import { ElectronAPI } from '@electron-toolkit/preload'

export type PendingBillRow = {
  clientLocalId: string
  payload: unknown
  display: unknown
  createdAt: number
  attempts: number
  lastError: string | null
  status: string
}

export type CashlioApi = {
  getMacAddress: () => Promise<string>
  db: {
    bill: {
      enqueue: (input: {
        clientLocalId: string
        payload: unknown
        display: unknown
      }) => Promise<{ ok: true; count: number }>
      listPending: () => Promise<PendingBillRow[]>
      countPending: () => Promise<number>
      listFailed: () => Promise<PendingBillRow[]>
      countFailed: () => Promise<number>
      retryFailed: (
        clientLocalId: string
      ) => Promise<{ ok: true; pending: number; failed: number }>
      remove: (clientLocalId: string) => Promise<{ ok: true; count: number }>
      markAttempted: (input: {
        clientLocalId: string
        error: string | null
      }) => Promise<{ ok: true }>
      markFailed: (input: {
        clientLocalId: string
        error: string
      }) => Promise<{ ok: true; count: number }>
    }
    product: {
      replaceCache: (
        products: Array<Record<string, unknown>>
      ) => Promise<{ ok: true; count: number; updatedAt: number }>
      search: (query: string, limit?: number) => Promise<unknown[]>
      cacheUpdatedAt: () => Promise<number | null>
    }
    mirror: {
      productSearch: (query: string, limit?: number) => Promise<unknown[]>
      productByItemCode: (itemCode: string) => Promise<unknown | null>
      productCount: () => Promise<number>
      customerSearch: (query: string, limit?: number) => Promise<unknown[]>
    }
    terminal: {
      nextBillNumber: (prefix: string) => Promise<string>
      peekBillNumber: (prefix: string) => Promise<string>
    }
    sync: {
      applyEvents: (events: unknown[]) => Promise<{
        applied: number
        lastId: string | null
        lastCursor: string | null
        stoppedAt: string | null
        error: string | null
      }>
      get: (key: string) => Promise<string | null>
      set: (key: string, value: string) => Promise<{ ok: true }>
    }
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CashlioApi
  }
}
