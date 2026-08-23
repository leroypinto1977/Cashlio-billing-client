import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, Plus, Minus, Trash2, User, X, CheckCircle2,
  ShoppingCart, ChevronDown,
  CloudOff, AlertCircle, RefreshCw, Database, Printer
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal } from './ui/modal'
import { printReceipt, type ReceiptBill, type ReceiptShop } from '../lib/receipt'
import { computeInvoiceTotals } from '@shared/money'
import { validateName, validateMobile } from '@shared/validation'
import {
  isLengthMode, parseQty, qtyStep, roundQty, formatQty, formatQtyWithUnit,
  type SellMode
} from '@shared/units'
import {
  settle, checkCredit, PAYMENT_METHODS,
  type PaymentMethod, type Tender, type CreditCheck
} from '@shared/credit'

// ─── Types ────────────────────────────────────────────────────────────────────

type Product = {
  id: string
  itemCode: string
  name: string
  brand: string | null
  unitOfMeasure: string
  sellingRate: number
  gstPercentage: number
  /** Fractional for cut-to-length products — 14.5 m of pipe, not 14 pieces. */
  totalStock: number
  /**
   * Absent on rows cached before cut-to-length shipped and on older branch
   * servers; every read goes through the @shared/units helpers, which treat
   * undefined as UNIT.
   */
  sellMode?: SellMode
}

type CartItem = {
  productId: string
  itemCode: string
  productName: string
  unitOfMeasure: string
  sellMode?: SellMode
  unitRate: number
  gstPercentage: number
  quantity: number
  maxQty: number
  lineDiscountPct: number
  lineDiscountAmt: number
  lineTotal: number
  lineGstAmount: number
}

type Customer = {
  id: string
  name: string
  phone: string
  email: string | null
  /**
   * Credit terms. Optional because a legacy branch server (or a mirror row
   * written before credit billing shipped) simply doesn't carry them — and
   * "unknown" must never be read as "unlimited", so every use goes through
   * `hasCreditTerms` below.
   */
  creditLimit?: number
  creditDays?: number
  outstanding?: number
}

/** True when we actually know this customer's credit position. */
const hasCreditTerms = (c: Customer | null): boolean =>
  c != null && typeof c.creditLimit === 'number' && typeof c.outstanding === 'number'

type SavedBill = {
  billNumber: string
  paidAt?: string
  totalAmount: number
  subtotal?: number
  gstAmount?: number
  discountAmount?: number
  taxableValue?: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  amountReceived?: number | null
  changeGiven: number | null
  paymentMethod: string
  /** Settlement — absent on bills from a pre-credit branch server. */
  paidAmount?: number
  balanceDue?: number
  dueDate?: string | null
  status?: string
  tenders?: Tender[]
  customerOutstanding?: number | null
  items: {
    productName: string; itemCode?: string; quantity: number; unitRate?: number; lineTotal: number
    gstPercentage?: number; taxableValue?: number; cgstAmount?: number; sgstAmount?: number
    igstAmount?: number; billDiscountAmt?: number
  }[]
  customer?: { name: string } | null
  synced?: boolean  // true = on server, false = saved locally pending sync
}

const AUTO_PRINT_KEY = 'cashlio_auto_print'
const isAutoPrintEnabled = () => localStorage.getItem(AUTO_PRINT_KEY) !== 'false'

// ─── Offline storage (SQLite via main process IPC) ───────────────────────────

const PRODUCT_CACHE_TTL_MS = 60 * 60 * 1000  // 1 hour — legacy cache refresh cadence

type PendingBillPayload = Record<string, unknown>
type PendingBillDisplay = { grandTotal: number; paymentMethod: string; itemCount: number }

// A queued bill the server rejected. `display` is whatever the till recorded
// at the time of sale, so the row is readable even though the payload never
// made it to the server.
type FailedBill = {
  clientLocalId: string
  display: unknown
  createdAt: number
  attempts: number
  lastError: string | null
}

// Phase 3D: local mirror is authoritative when offline. The legacy
// product_cache (1-hour TTL) is kept as a fallback for terminals that haven't
// re-paired post-3D and therefore have an empty mirror.
async function searchLocalProducts(query: string): Promise<Product[]> {
  try {
    const mirror = (await window.api.db.mirror.productSearch(query, 20)) as Product[]
    if (mirror.length > 0) return mirror
    // Fallback for empty mirror (first-time launch before initial sync).
    return (await window.api.db.product.search(query, 20)) as Product[]
  } catch {
    return []
  }
}

// One-shot migration: drain any leftover localStorage data from older builds
// into SQLite, then clear it. Idempotent.
const MIGRATION_FLAG = 'cashlio_sqlite_migrated_v1'
async function migrateLegacyLocalStorage(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG) === '1') return
  try {
    const rawPending = localStorage.getItem('cashlio_pending_bills')
    if (rawPending) {
      const list = JSON.parse(rawPending) as Array<{
        localId: string
        payload: PendingBillPayload
        display: PendingBillDisplay
      }>
      for (const b of list) {
        await window.api.db.bill.enqueue({
          clientLocalId: b.localId,
          payload: b.payload,
          display: b.display
        })
      }
      localStorage.removeItem('cashlio_pending_bills')
    }
    const rawCache = localStorage.getItem('cashlio_product_cache')
    if (rawCache) {
      const parsed = JSON.parse(rawCache) as { products?: Product[] }
      if (parsed.products?.length) {
        await window.api.db.product.replaceCache(
          parsed.products as unknown as Array<Record<string, unknown>>
        )
      }
      localStorage.removeItem('cashlio_product_cache')
      localStorage.removeItem('cashlio_product_cache_ts')
    }
  } catch (e) {
    console.warn('legacy migration failed (non-fatal):', e)
  }
  localStorage.setItem(MIGRATION_FLAG, '1')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcLine(item: Omit<CartItem, 'lineTotal' | 'lineGstAmount'>): Pick<CartItem, 'lineTotal' | 'lineGstAmount'> {
  const base = item.quantity * item.unitRate
  const pctDisc = base * (item.lineDiscountPct / 100)
  const lineTotal = Math.max(0, base - pctDisc - item.lineDiscountAmt)
  const lineGstAmount = item.gstPercentage > 0
    ? lineTotal * item.gstPercentage / (100 + item.gstPercentage)
    : 0
  return { lineTotal, lineGstAmount }
}

/**
 * Keeps a quantity sellable: never zero or negative, never more than the stock
 * on hand, and never finer than the product's smallest increment.
 */
function clampQty(qty: number, opts: { maxQty: number; sellMode?: SellMode }): number {
  const step = qtyStep(opts.sellMode)
  const max = opts.maxQty > 0 ? opts.maxQty : step
  return roundQty(Math.min(Math.max(qty, step), max))
}

function fmt(n: number) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Tenders ──────────────────────────────────────────────────────────────────

/**
 * One row of the payment panel. Amounts stay as raw strings while the cashier
 * is typing, for the same reason cut-length quantities do — parsing "1" out of
 * "1." mid-keystroke would make the decimal point untypeable.
 */
type TenderLine = { id: string; method: PaymentMethod; amount: string; reference: string }

const newTenderLine = (method: PaymentMethod = 'CASH'): TenderLine => ({
  id: crypto.randomUUID(), method, amount: '', reference: ''
})

/** Methods where a reference number (UPI ref, cheque no.) is worth capturing. */
const NEEDS_REFERENCE: readonly PaymentMethod[] = ['UPI', 'CARD', 'CHEQUE']


/**
 * How much of a customer's limit we refuse to spend while the branch server is
 * unreachable.
 *
 * Offline, `outstanding` is only as fresh as the last pull-sync: another
 * terminal may have put more on the same account since, and the queued bill is
 * only checked for real when it finally reaches the server — where a breach
 * would bounce it to failed_permanent long after the customer has walked out.
 * So we require visible headroom rather than letting a credit sale fill the
 * limit to the brim.
 */
const OFFLINE_CREDIT_HEADROOM = 0.1  // keep 10% of the limit in reserve

function offlineCreditAllowed(check: CreditCheck): boolean {
  if (!check.allowed) return false
  const reserve = check.creditLimit * OFFLINE_CREDIT_HEADROOM
  return check.projectedOutstanding + reserve <= check.creditLimit
}

// ─── BillingScreen ────────────────────────────────────────────────────────────

export default function BillingScreen({ onPendingCountChange }: { onPendingCountChange?: (n: number) => void } = {}) {
  const ip = localStorage.getItem('mainServerIp') || ''
  const port = localStorage.getItem('mainServerPort') || '52001'
  const apiBase = `http://${ip}:${port}`
  const token = localStorage.getItem('cashierToken')
  const deviceId = localStorage.getItem('terminalDeviceId') || ''
  // Phase 3D: present if the terminal has been (re-)paired post-3D. Empty for
  // legacy installs — they fall back to server-minted bill numbers (online only).
  const terminalCode = localStorage.getItem('terminalCode') || ''

  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }

  async function apiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { ...authHeaders, ...(options?.headers as Record<string, string> | undefined) }
    })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error || 'API_ERROR'), { status: res.status, data })
    return data as T
  }

  // Cart
  const [cartItems, setCartItems] = useState<CartItem[]>([])

  // Search
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pending quantity prompt
  const [pendingProduct, setPendingProduct] = useState<Product | null>(null)
  const [pendingQty, setPendingQty] = useState('1')
  const pendingQtyRef = useRef<HTMLInputElement>(null)

  // Customer
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [showCustomerModal, setShowCustomerModal] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerResults, setCustomerResults] = useState<Customer[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerPhone, setNewCustomerPhone] = useState('')
  const [newCustomerError, setNewCustomerError] = useState('')

  // Discounts
  const [billDiscountFlat, setBillDiscountFlat] = useState('')
  const [billDiscountPct, setBillDiscountPct] = useState('')

  // Payment — a list of tenders, so a bill can be split across cash and UPI.
  // The common case stays one-touch: a single line whose amount tracks the
  // grand total until the cashier types an amount of their own, at which point
  // `tendersEdited` flips and the typed figures are taken literally.
  const [tenderLines, setTenderLines] = useState<TenderLine[]>(() => [newTenderLine('CASH')])
  const [tendersEdited, setTendersEdited] = useState(false)

  // Whether the attached customer's credit figures came from the local mirror
  // (i.e. as of the last sync) rather than straight from the branch server.
  const [customerFiguresStale, setCustomerFiguresStale] = useState(false)
  const [customerResultsStale, setCustomerResultsStale] = useState(false)

  // Submit
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [successBill, setSuccessBill] = useState<SavedBill | null>(null)

  // Offline sync — counts come from SQLite, populated async.
  const [pendingCount, setPendingCount] = useState(0)
  // Bills the branch server rejected outright. They stop retrying, so unless
  // the till says so nobody ever learns that a sale never reached the books.
  const [failedBills, setFailedBills] = useState<FailedBill[]>([])
  const [showFailedModal, setShowFailedModal] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const syncingRef = useRef(false)
  const latestSyncRef = useRef<(() => Promise<void>) | undefined>(undefined)

  // Product cache
  const [usingCachedProducts, setUsingCachedProducts] = useState(false)
  const cachingRef = useRef(false)
  const latestCacheRef = useRef<(() => Promise<void>) | undefined>(undefined)

  // Bill number preview
  const [billNumber, setBillNumber] = useState<string>('')

  // Shop info (for receipt header)
  const [shopInfo, setShopInfo] = useState<ReceiptShop>({ name: 'My Shop' })

  // Auto-print toggle (persisted)
  const [autoPrint, setAutoPrint] = useState<boolean>(() => isAutoPrintEnabled())
  useEffect(() => { localStorage.setItem(AUTO_PRINT_KEY, autoPrint ? 'true' : 'false') }, [autoPrint])

  const cashierName = (() => {
    try { return localStorage.getItem('cashierUsername') || undefined } catch { return undefined }
  })()

  // Fetch next bill number + shop info on mount.
  // With a terminalCode the preview is read from the local seq (works offline).
  // Without one we fall back to the server (legacy behaviour, online-only).
  useEffect(() => {
    if (terminalCode) {
      window.api.db.terminal.peekBillNumber(terminalCode)
        .then((bn) => bn && setBillNumber(bn))
        .catch(() => {})
    } else {
      apiFetch<{ billNumber: string }>('/api/v1/system/next-bill-number')
        .then((d) => setBillNumber(d.billNumber))
        .catch(() => {})
    }
    apiFetch<{
      shopName?: string; branchName?: string
      address?: string | null; phone?: string | null; gstin?: string | null
    }>('/api/v1/system/status')
      .then((d) =>
        setShopInfo({
          name: d.shopName || 'My Shop',
          branch: d.branchName || null,
          address: d.address ?? null,
          phone: d.phone ?? null,
          gstin: d.gstin ?? null
        })
      )
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Convert a SavedBill into the shape the receipt module expects.
  const buildReceiptPayload = (b: SavedBill): ReceiptBill => ({
    billNumber: b.billNumber,
    paidAt: b.paidAt,
    paymentMethod: b.paymentMethod,
    subtotal: b.subtotal,
    gstAmount: b.gstAmount,
    discountAmount: b.discountAmount,
    totalAmount: b.totalAmount,
    taxableValue: b.taxableValue,
    cgstAmount: b.cgstAmount,
    sgstAmount: b.sgstAmount,
    igstAmount: b.igstAmount,
    amountReceived: b.amountReceived ?? null,
    changeGiven: b.changeGiven,
    customerName: b.customer?.name ?? null,
    cashierName,
    items: b.items.map((it) => ({
      itemCode: it.itemCode || '',
      productName: it.productName,
      quantity: it.quantity,
      unitRate: it.unitRate ?? (it.quantity > 0 ? it.lineTotal / it.quantity : 0),
      lineTotal: it.lineTotal,
      gstPercentage: it.gstPercentage,
      taxableValue: it.taxableValue,
      cgstAmount: it.cgstAmount,
      sgstAmount: it.sgstAmount,
      igstAmount: it.igstAmount,
      billDiscountAmt: it.billDiscountAmt
    }))
  })

  const [printingState, setPrintingState] = useState<'idle' | 'printing' | 'error'>('idle')
  const [printError, setPrintError] = useState<string>('')
  const handlePrint = async (b: SavedBill, copy?: string) => {
    setPrintingState('printing')
    setPrintError('')
    const r = await printReceipt(shopInfo, buildReceiptPayload(b), copy ? { copyLabel: copy } : {})
    if (r.ok) setPrintingState('idle')
    else { setPrintingState('error'); setPrintError(r.error || 'Print failed') }
  }

  // ─── Product search (debounced, with cache fallback) ─────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!search.trim()) {
      setSearchResults([])
      setShowDropdown(false)
      setUsingCachedProducts(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const data = await apiFetch<{ products: Product[] }>(
          `/api/v1/products?search=${encodeURIComponent(search)}&isActive=true`
        )
        setSearchResults(data.products)
        setUsingCachedProducts(false)
        setShowDropdown(true)
      } catch {
        // Server unreachable — fall back to local product cache
        const cached = await searchLocalProducts(search)
        setSearchResults(cached)
        setUsingCachedProducts(true)
        setShowDropdown(cached.length > 0)
      } finally {
        setSearchLoading(false)
      }
    }, 250)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ─── Cart ops ────────────────────────────────────────────────────────────

  // Focus qty input when a product is selected from the dropdown
  useEffect(() => {
    if (pendingProduct && pendingQtyRef.current) {
      pendingQtyRef.current.focus()
      pendingQtyRef.current.select()
    }
  }, [pendingProduct])

  const selectProduct = (p: Product) => {
    setSearch('')
    setShowDropdown(false)
    setPendingProduct(p)
    setPendingQty('1')
  }

  // Barcode scanner support: a wedge scanner types the code + Enter.
  // If the typed query exactly matches a product's itemCode, add 1 qty
  // straight to cart and clear the search so the next scan is ready.
  // Falls back to selecting the lone result if no exact match.
  const addProductDirect = (p: Product) => {
    if (p.totalStock <= 0) return
    // A scanned length of pipe has no implied quantity — 1 m would be a guess,
    // so the cashier is asked to measure instead of being given a wrong line.
    if (isLengthMode(p.sellMode)) { selectProduct(p); return }
    setCartItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === p.id)
      if (idx >= 0) {
        return prev.map((it, i) => {
          if (i !== idx) return it
          const q = clampQty(it.quantity + qtyStep(it.sellMode), it)
          const next = { ...it, quantity: q }
          return { ...next, ...calcLine(next) }
        })
      }
      const base: Omit<CartItem, 'lineTotal' | 'lineGstAmount'> = {
        productId: p.id, itemCode: p.itemCode,
        productName: p.name, unitOfMeasure: p.unitOfMeasure,
        sellMode: p.sellMode ?? 'UNIT',
        unitRate: p.sellingRate, gstPercentage: p.gstPercentage,
        quantity: 1, maxQty: p.totalStock,
        lineDiscountPct: 0, lineDiscountAmt: 0
      }
      return [...prev, { ...base, ...calcLine(base) }]
    })
    setSearch('')
    setSearchResults([])
    setShowDropdown(false)
    setPendingProduct(null)
  }

  const handleSearchEnter = async () => {
    if (!search.trim() || pendingProduct) return
    const q = search.trim()
    const ql = q.toLowerCase()

    // First, try with whatever we already have (covers the common case).
    const exactCached = searchResults.find((p) => p.itemCode.toLowerCase() === ql)
    if (exactCached) { addProductDirect(exactCached); return }

    // Scanners often hit Enter before the 250ms debounce fires. Cancel any
    // pending debounce and fetch synchronously so the scan is never lost.
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchLoading(true)
    try {
      const data = await apiFetch<{ products: Product[] }>(
        `/api/v1/products?search=${encodeURIComponent(q)}&isActive=true`
      )
      setSearchResults(data.products)
      setUsingCachedProducts(false)
      const exact = data.products.find((p) => p.itemCode.toLowerCase() === ql)
      if (exact) { addProductDirect(exact); return }
      setShowDropdown(true)
    } catch {
      // Offline: try cache for an exact itemCode hit.
      const cached = await searchLocalProducts(q)
      const exact = cached.find((p) => p.itemCode.toLowerCase() === ql)
      if (exact) { addProductDirect(exact); return }
      setSearchResults(cached)
      setUsingCachedProducts(true)
      setShowDropdown(cached.length > 0)
    } finally {
      setSearchLoading(false)
    }
  }

  const confirmAddToCart = () => {
    if (!pendingProduct) return
    // parseQty keeps 3 decimals for cut lengths and floors whole-unit entries,
    // so "2.5" is 2.5 m of cable but only 2 switches.
    const qty = clampQty(parseQty(pendingQty, pendingProduct.sellMode), {
      maxQty: pendingProduct.totalStock,
      sellMode: pendingProduct.sellMode
    })
    setCartItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === pendingProduct.id)
      if (idx >= 0) {
        return prev.map((it, i) => {
          if (i !== idx) return it
          const next = { ...it, quantity: qty }
          return { ...next, ...calcLine(next) }
        })
      }
      const base: Omit<CartItem, 'lineTotal' | 'lineGstAmount'> = {
        productId: pendingProduct.id, itemCode: pendingProduct.itemCode,
        productName: pendingProduct.name, unitOfMeasure: pendingProduct.unitOfMeasure,
        sellMode: pendingProduct.sellMode ?? 'UNIT',
        unitRate: pendingProduct.sellingRate, gstPercentage: pendingProduct.gstPercentage,
        quantity: qty, maxQty: pendingProduct.totalStock,
        lineDiscountPct: 0, lineDiscountAmt: 0
      }
      return [...prev, { ...base, ...calcLine(base) }]
    })
    setPendingProduct(null)
    setPendingQty('1')
  }

  // Whole-unit lines step by 1 from the +/− buttons.
  const updateQty = (idx: number, direction: 1 | -1) => {
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const q = clampQty(it.quantity + direction * qtyStep(it.sellMode), it)
      const next = { ...it, quantity: q }
      return { ...next, ...calcLine(next) }
    }))
  }

  // Cut-to-length lines are typed instead: nudging 14.5 m by 0.001 would be
  // useless. The raw keystrokes live in `qtyDraft` until the field is left,
  // otherwise "2." would be parsed back to "2" and the decimal point could
  // never be typed at all.
  const [qtyDraft, setQtyDraft] = useState<{ idx: number; value: string } | null>(null)

  const commitQtyDraft = (idx: number, raw: string): void => {
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const q = clampQty(parseQty(raw, it.sellMode), it)
      const next = { ...it, quantity: q }
      return { ...next, ...calcLine(next) }
    }))
    setQtyDraft(null)
  }

  const updateDiscount = (idx: number, field: 'lineDiscountPct' | 'lineDiscountAmt', raw: string) => {
    const val = parseFloat(raw) || 0
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const next: CartItem = field === 'lineDiscountPct'
        ? { ...it, lineDiscountPct: val, lineDiscountAmt: 0 }
        : { ...it, lineDiscountAmt: val, lineDiscountPct: 0 }
      return { ...next, ...calcLine(next) }
    }))
  }

  const removeItem = (idx: number) => {
    // Row indices shift on removal, so an open draft would target the wrong line.
    setQtyDraft(null)
    setCartItems((prev) => prev.filter((_, i) => i !== idx))
  }

  // ─── Totals ──────────────────────────────────────────────────────────────

  const rawSubtotal = cartItems.reduce((s, it) => s + it.lineTotal, 0)
  const billDiscFlat = parseFloat(billDiscountFlat) || 0
  const billDiscPct = parseFloat(billDiscountPct) || 0
  // Same calculator the server uses, so an offline receipt printed at the
  // counter matches the invoice the server stores once the bill syncs.
  const totals = computeInvoiceTotals(
    cartItems.map((it) => ({ lineTotal: it.lineTotal, gstPercentage: it.gstPercentage })),
    rawSubtotal * billDiscPct / 100 + billDiscFlat,
    false
  )
  const subtotal = totals.subtotal
  const billDiscAmt = totals.billDiscount
  const grandTotal = totals.totalAmount
  const totalGst = totals.gstAmount
  const taxableValue = totals.taxableValue
  const cgstAmount = totals.cgstAmount
  const sgstAmount = totals.sgstAmount
  const tenderList: Tender[] = tenderLines.map((t) => ({
    method: t.method,
    amount: parseFloat(t.amount) || 0,
    reference: t.reference.trim() || null
  }))
  // Same arithmetic the branch server applies, so an offline receipt printed
  // here matches the invoice stored once the bill syncs.
  const settlement = settle(grandTotal, tenderList)
  const balanceDue = settlement.balanceDue
  const change = settlement.changeGiven

  // The customer's ledger, as far as this terminal knows it. Offline that is
  // the mirrored figure from the last sync, which is why it is labelled.
  const creditLimit = hasCreditTerms(customer) ? (customer?.creditLimit ?? 0) : 0
  const currentOutstanding = customer?.outstanding ?? 0
  const availableCredit = Math.max(0, creditLimit - currentOutstanding)
  const creditCheck: CreditCheck = checkCredit({
    hasCustomer: !!customer,
    creditLimit,
    currentOutstanding,
    newBalance: balanceDue
  })

  // A terminal cannot authorise an override, so anything the local figures say
  // would be refused is blocked here rather than queued to fail at sync.
  const canPay =
    grandTotal > 0 &&
    (balanceDue <= 0 ||
      (customerFiguresStale ? offlineCreditAllowed(creditCheck) : creditCheck.allowed))

  // A single untouched cash line follows the bill total.
  useEffect(() => {
    if (tendersEdited) return
    setTenderLines((prev) => {
      const want = grandTotal > 0 ? String(roundQty(grandTotal)) : ''
      if (prev.length !== 1 || prev[0].method !== 'CASH' || prev[0].amount === want) return prev
      return [{ ...prev[0], amount: want }]
    })
  }, [grandTotal, tendersEdited])

  // The chosen customer's figures are stale whenever the list they came from
  // was served by the mirror rather than the branch server.
  useEffect(() => {
    setCustomerFiguresStale(customer != null && customerResultsStale)
  }, [customer, customerResultsStale])

  const updateTender = (idx: number, patch: Partial<Omit<TenderLine, 'id'>>) => {
    setTendersEdited(true)
    setTenderLines((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }
  const addTender = () => {
    setTendersEdited(true)
    const rest = Math.max(0, grandTotal - tenderList.reduce((s, t) => s + t.amount, 0))
    setTenderLines((prev) => {
      const method: PaymentMethod = prev.some((t) => t.method === 'CASH') ? 'UPI' : 'CASH'
      const line = newTenderLine(method)
      return [...prev, { ...line, amount: rest > 0 ? String(roundQty(rest)) : '' }]
    })
  }
  const removeTender = (idx: number) => {
    setTendersEdited(true)
    setTenderLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }
  const resetTenders = () => {
    setTenderLines([newTenderLine('CASH')])
    setTendersEdited(false)
  }

  // ─── Customer search ─────────────────────────────────────────────────────

  const searchCustomers = useCallback(async (q: string) => {
    if (!q.trim()) { setCustomerResults([]); return }
    setCustomerSearchLoading(true)
    try {
      const d = await apiFetch<{ customers: Customer[] }>(
        `/api/v1/customers?search=${encodeURIComponent(q)}&autocomplete=1`
      )
      setCustomerResults(d.customers)
      setCustomerResultsStale(false)
    } catch {
      // Server unreachable — fall back to the local mirror (Phase 3D). Credit
      // figures from there are only as fresh as the last sync.
      try {
        const local = (await window.api.db.mirror.customerSearch(q, 20)) as Customer[]
        setCustomerResults(local)
        setCustomerResultsStale(true)
      } catch {
        setCustomerResults([])
      }
    }
    finally { setCustomerSearchLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 250)
    return () => clearTimeout(t)
  }, [customerSearch, searchCustomers])

  const handleAddCustomer = async () => {
    // Same rules the server enforces, so the cashier finds out about a bad
    // number before the round trip rather than after it.
    const nameCheck = validateName(newCustomerName, 'Customer name')
    if (!nameCheck.ok) { setNewCustomerError(nameCheck.message); return }
    const phoneCheck = validateMobile(newCustomerPhone)
    if (!phoneCheck.ok) { setNewCustomerError(phoneCheck.message); return }

    try {
      const d = await apiFetch<{ customer: Customer }>('/api/v1/customers', {
        method: 'POST',
        body: JSON.stringify({ name: nameCheck.value, phone: phoneCheck.value })
      })
      setCustomer(d.customer)
      setShowCustomerModal(false)
      resetCustomerModal()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      if (e.data?.error === 'PHONE_ALREADY_EXISTS') {
        setNewCustomerError('A customer with this phone number already exists.')
      } else {
        setNewCustomerError(e.data?.message || 'Could not add the customer.')
      }
    }
  }

  const resetCustomerModal = () => {
    setCustomerSearch(''); setCustomerResults([])
    setShowAddCustomer(false); setNewCustomerName(''); setNewCustomerPhone(''); setNewCustomerError('')
  }

  // ─── Submit Bill ─────────────────────────────────────────────────────────

  const handlePay = async () => {
    if (!canPay || cartItems.length === 0) return
    setSubmitting(true)
    setSubmitError('')
    const localId = crypto.randomUUID()
    // Phase 3D: mint the bill number locally up front so online and offline
    // flows produce identical, monotonic, terminal-prefixed numbers (e.g.
    // "T1-00042"). The increment is atomic; if submit fails we don't roll it
    // back — gaps in the local sequence are harmless.
    const localBillNumber = terminalCode
      ? await window.api.db.terminal.nextBillNumber(terminalCode).catch(() => '')
      : ''
    const paidTenders = tenderList.filter((t) => t.amount > 0)
    const body: Record<string, unknown> = {
      customerId: customer?.id ?? null,
      originDeviceId: deviceId,
      items: cartItems.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        unitRate: it.unitRate,
        gstPercentage: it.gstPercentage,
        lineDiscountPct: it.lineDiscountPct,
        lineDiscountAmt: it.lineDiscountAmt
      })),
      discountAmount: billDiscAmt,
      payments: paidTenders,
      clientLocalId: localId,
      // Stamped here, at the counter. An offline bill can sit in the queue
      // until the network comes back, and dating it on arrival would put the
      // takings on the wrong day and age the customer's credit from the wrong
      // date. The server sanity-checks this against its own clock.
      soldAt: new Date().toISOString()
    }
    if (localBillNumber) body.billNumber = localBillNumber
    try {
      const d = await apiFetch<{ bill: SavedBill }>('/api/v1/bills', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      setSuccessBill({ ...d.bill, synced: true })
      // We're online — attempt to flush any pending offline bills
      setTimeout(() => latestSyncRef.current?.(), 200)
    } catch (err: unknown) {
      const e = err as {
        data?: { error?: string; message?: string; productName?: string; available?: number }
        status?: number
      }
      if (e.data?.error === 'INSUFFICIENT_STOCK') {
        setSubmitError(`Insufficient stock for "${e.data.productName}" (available: ${formatQty(e.data.available)}).`)
      } else if (e.data?.error === 'CREDIT_NOT_ALLOWED') {
        // A terminal cannot authorise an override — that is a manager's call.
        setSubmitError(`${e.data.message ?? 'Credit is not available for this bill.'} Ask a manager to authorise it.`)
      } else if (e.status && e.status >= 400 && e.status < 500) {
        // Business-logic rejection — don't save offline
        setSubmitError('Failed to process bill. Please check cart and try again.')
      } else {
        // Network down or server error — save the bill locally so nothing is lost.
        // SQLite write is atomic + WAL-journalled, so a power cut can never
        // leave a partial bill on disk.
        const enq = await window.api.db.bill.enqueue({
          clientLocalId: localId,
          payload: body as PendingBillPayload,
          display: { grandTotal, paymentMethod: paidTenders[0]?.method ?? 'CREDIT', itemCount: cartItems.length }
        })
        setPendingCount(enq.count)
        onPendingCountChange?.(enq.count)
        setSuccessBill({
          billNumber: localBillNumber || `PENDING-${localId.slice(0, 8).toUpperCase()}`,
          paidAt: new Date().toISOString(),
          totalAmount: grandTotal,
          subtotal,
          gstAmount: totalGst,
          discountAmount: billDiscAmt,
          taxableValue,
          cgstAmount,
          sgstAmount,
          igstAmount: 0,
          amountReceived: settlement.tendered > 0 ? settlement.tendered : null,
          changeGiven: settlement.changeGiven > 0 ? settlement.changeGiven : null,
          paidAmount: settlement.paidAmount,
          balanceDue: settlement.balanceDue,
          status: settlement.status,
          tenders: paidTenders,
          customerOutstanding: customer ? currentOutstanding + settlement.balanceDue : null,
          paymentMethod: paidTenders[0]?.method ?? 'CREDIT',
          customer: customer ? { name: customer.name } : null,
          items: cartItems.map((it, i) => ({
            productName: it.productName,
            itemCode: it.itemCode,
            quantity: it.quantity,
            unitRate: it.unitRate,
            lineTotal: it.lineTotal,
            gstPercentage: it.gstPercentage,
            taxableValue: totals.lines[i]?.taxableValue,
            cgstAmount: totals.lines[i]?.cgstAmount,
            sgstAmount: totals.lines[i]?.sgstAmount,
            igstAmount: totals.lines[i]?.igstAmount,
            billDiscountAmt: totals.lines[i]?.billDiscountAmt
          })),
          synced: false
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ─── New Bill ─────────────────────────────────────────────────────────────

  const startNewBill = () => {
    setCartItems([])
    setQtyDraft(null)
    setCustomer(null)
    setBillDiscountFlat('')
    setBillDiscountPct('')
    resetTenders()
    setSubmitError('')
    setSuccessBill(null)
    if (terminalCode) {
      window.api.db.terminal.peekBillNumber(terminalCode)
        .then((bn) => bn && setBillNumber(bn))
        .catch(() => {})
    } else {
      apiFetch<{ billNumber: string }>('/api/v1/system/next-bill-number')
        .then((d) => setBillNumber(d.billNumber))
        .catch(() => {})
    }
  }

  // ─── Offline sync ─────────────────────────────────────────────────────────

  const syncPendingBills = async () => {
    if (syncingRef.current) return
    const pending = await window.api.db.bill.listPending()
    if (pending.length === 0) {
      const c = await window.api.db.bill.countPending()
      setPendingCount(c)
      onPendingCountChange?.(c)
      setFailedBills(await window.api.db.bill.listFailed())
      return
    }
    syncingRef.current = true
    try {
      for (const entry of pending) {
        try {
          await apiFetch('/api/v1/bills', {
            method: 'POST',
            body: JSON.stringify(entry.payload)
          })
          await window.api.db.bill.remove(entry.clientLocalId)
        } catch (err) {
          const e = err as { status?: number; message?: string }
          if (!e.status) {
            // network error — stop and retry later. Record the attempt.
            await window.api.db.bill.markAttempted({
              clientLocalId: entry.clientLocalId,
              error: e.message || 'NETWORK'
            })
            break
          }
          if (e.status >= 400 && e.status < 500) {
            // 4xx: permanent rejection (e.g. product removed). Mark failed_permanent
            // rather than silently dropping — preserves the audit trail.
            // Keep the server's own reason. "HTTP_400" tells the shop nothing;
            // "INSUFFICIENT_STOCK" tells them exactly what to go and fix.
            await window.api.db.bill.markFailed({
              clientLocalId: entry.clientLocalId,
              error: e.message ? `${e.message} (HTTP ${e.status})` : `HTTP_${e.status}`
            })
          } else {
            await window.api.db.bill.markAttempted({
              clientLocalId: entry.clientLocalId,
              error: `HTTP_${e.status}`
            })
            break
          }
        }
      }
    } finally {
      syncingRef.current = false
      const remaining = await window.api.db.bill.countPending()
      setPendingCount(remaining)
      onPendingCountChange?.(remaining)
      setFailedBills(await window.api.db.bill.listFailed())
    }
  }

  // Keep ref pointing to latest syncPendingBills (avoids stale closure in setInterval)
  latestSyncRef.current = syncPendingBills

  // Startup: run legacy migration, hydrate count, then sync. Periodic sync every 30 s.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await migrateLegacyLocalStorage()
      if (cancelled) return
      const c = await window.api.db.bill.countPending()
      setPendingCount(c)
      onPendingCountChange?.(c)
      setFailedBills(await window.api.db.bill.listFailed())
      latestSyncRef.current?.()
    })()
    const id = setInterval(() => latestSyncRef.current?.(), 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Product cache refresh ────────────────────────────────────────────────

  const refreshProductCache = async () => {
    if (cachingRef.current) return
    const ts = await window.api.db.product.cacheUpdatedAt()
    if (ts && Date.now() - ts < PRODUCT_CACHE_TTL_MS) return
    cachingRef.current = true
    try {
      const data = await apiFetch<{ products: Product[] }>('/api/v1/products?isActive=true&limit=1000')
      await window.api.db.product.replaceCache(
        data.products as unknown as Array<Record<string, unknown>>
      )
    } catch {
      // Server unreachable — keep existing cache, will retry next hour
    } finally {
      cachingRef.current = false
    }
  }

  latestCacheRef.current = refreshProductCache

  // Startup cache refresh + hourly refresh
  useEffect(() => {
    latestCacheRef.current?.()
    const id = setInterval(() => latestCacheRef.current?.(), PRODUCT_CACHE_TTL_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Phase 3D: pull-sync (server → terminal) ──────────────────────────────

  const pullingRef = useRef(false)
  const latestPullRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const pullSync = async () => {
    if (pullingRef.current) return
    pullingRef.current = true
    try {
      // Loop until the server says no more pages, so a long backlog catches
      // up promptly after a reconnect rather than dripping in 30s at a time.
      let safety = 20  // max 20 pages = 10k events per tick
      // eslint-disable-next-line no-constant-condition
      while (safety-- > 0) {
        const cursor = (await window.api.db.sync.get('pull_cursor')) || '0'
        let resp: {
          events: Array<{
            id: string
            cursor?: string
            entity: string
            entityId: string
            op: string
            payload: unknown
          }>
          nextCursor: string
          hasMore: boolean
        }
        try {
          resp = await apiFetch(`/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=500`)
        } catch {
          // Server unreachable — try again on next tick.
          break
        }
        if (!resp.events || resp.events.length === 0) break
        const result = await window.api.db.sync.applyEvents(resp.events)
        // Store the server's own resume token, not the row id — it pages by
        // commit order, which the id does not describe.
        if (result.lastCursor) await window.api.db.sync.set('pull_cursor', result.lastCursor)
        if (result.stoppedAt) {
          // An event refused to apply. The cursor is parked before it, so
          // looping would just hit the same row again — stop and let the next
          // tick try once, rather than spinning twenty times a minute.
          console.warn('[sync] pull stalled at event', result.stoppedAt, result.error)
          break
        }
        if (!resp.hasMore) break
      }
    } finally {
      pullingRef.current = false
    }
  }

  latestPullRef.current = pullSync

  useEffect(() => {
    latestPullRef.current?.()
    const id = setInterval(() => latestPullRef.current?.(), 30_000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-print when a bill lands successfully (online or offline)
  const autoPrintFiredFor = useRef<string | null>(null)
  useEffect(() => {
    if (!successBill) { autoPrintFiredFor.current = null; return }
    if (!autoPrint) return
    if (autoPrintFiredFor.current === successBill.billNumber) return
    autoPrintFiredFor.current = successBill.billNumber
    handlePrint(successBill)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successBill, autoPrint])

  // ─── Success Overlay ─────────────────────────────────────────────────────

  if (successBill) {
    const isOffline = successBill.synced === false
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-6 text-center p-8">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${isOffline ? 'bg-amber-100' : 'bg-emerald-100'}`}>
          {isOffline
            ? <CloudOff className="w-11 h-11 text-amber-600" strokeWidth={1.5} />
            : <CheckCircle2 className="w-11 h-11 text-emerald-600" strokeWidth={1.5} />
          }
        </div>
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">
            {isOffline ? 'Bill Saved Offline' : 'Payment Collected'}
          </h2>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{successBill.billNumber}</p>
          {isOffline && (
            <p className="text-amber-600 text-xs mt-2 max-w-xs">
              Server unreachable. Bill stored locally and will sync automatically when connection is restored.
            </p>
          )}
        </div>
        <div className={`border rounded-xl p-6 w-full max-w-sm text-left space-y-2 ${isOffline ? 'bg-amber-50 border-amber-200' : 'bg-zinc-50'}`}>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total Charged</span>
            <span className="font-bold text-lg">₹{fmt(successBill.totalAmount)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Payment</span>
            <span className="font-medium">{successBill.paymentMethod}</span>
          </div>
          {successBill.changeGiven != null && successBill.changeGiven > 0 && (
            <div className="flex justify-between text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Change</span>
              <span className="font-bold text-emerald-700">₹{fmt(successBill.changeGiven)}</span>
            </div>
          )}
          <div className="border-t pt-3 mt-2 space-y-1">
            {successBill.items?.map((it, i) => (
              <div key={i} className="flex justify-between text-xs text-muted-foreground">
                <span>{it.productName} × {formatQty(it.quantity)}</span>
                <span>₹{fmt(it.lineTotal)}</span>
              </div>
            ))}
          </div>
        </div>
        {printError && (
          <p className="text-xs text-red-600">Print: {printError}</p>
        )}
        <div className="flex gap-3 flex-wrap justify-center">
          <Button
            variant="outline"
            onClick={() => handlePrint(successBill, autoPrintFiredFor.current === successBill.billNumber ? 'REPRINT' : undefined)}
            disabled={printingState === 'printing'}
            className="gap-2 h-11 px-5"
          >
            <Printer className="w-4 h-4" />
            {printingState === 'printing' ? 'Printing…' : (autoPrintFiredFor.current === successBill.billNumber ? 'Reprint' : 'Print Receipt')}
          </Button>
          {isOffline && (
            <Button variant="outline" onClick={() => syncPendingBills()} className="gap-2 h-11 px-5">
              <RefreshCw className="w-4 h-4" /> Retry Sync
            </Button>
          )}
          <Button onClick={startNewBill} className="gap-2 h-11 px-8">
            <Plus className="w-4 h-4" /> New Bill
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
          <input
            type="checkbox"
            checked={autoPrint}
            onChange={(e) => setAutoPrint(e.target.checked)}
            className="w-3.5 h-3.5 accent-zinc-800"
          />
          Auto-print receipt after each bill
        </label>
      </div>
    )
  }

  // ─── Main Billing UI ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 p-4 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ShoppingCart className="w-5 h-5" /> New Bill
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            {billNumber && (
              <p className="text-xs text-muted-foreground font-mono">{billNumber}</p>
            )}
            {pendingCount > 0 && (
              <button
                type="button"
                onClick={() => syncPendingBills()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full hover:bg-amber-100 transition-colors"
                title="Click to retry sync"
              >
                <AlertCircle className="w-3 h-3" />
                {pendingCount} pending sync
              </button>
            )}
            {failedBills.length > 0 && (
              <button
                type="button"
                onClick={() => setShowFailedModal(true)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full hover:bg-red-100 transition-colors"
                title="These sales were rejected and are not in the books"
              >
                <AlertCircle className="w-3 h-3" />
                {failedBills.length} rejected
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {customer ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-zinc-50 text-sm">
              <User className="w-3.5 h-3.5 text-zinc-500" />
              <span className="font-medium text-zinc-800">{customer.name}</span>
              <span className="text-muted-foreground text-xs">{customer.phone}</span>
              <button type="button" onClick={() => setCustomer(null)} className="text-zinc-400 hover:text-zinc-700 ml-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setShowCustomerModal(true)} className="gap-2 text-sm h-9">
              <User className="w-3.5 h-3.5" /> Attach Customer
            </Button>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* LEFT PANEL */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Search bar */}
          <div className="mb-3" ref={searchRef}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPendingProduct(null) }}
                onFocus={() => search && setShowDropdown(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowDropdown(false)
                  else if (e.key === 'Enter') { e.preventDefault(); handleSearchEnter() }
                }}
                placeholder="Scan barcode or search by name / item code..."
                className="pl-9 h-10 text-sm"
                autoFocus={!pendingProduct}
              />
              {searchLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
              )}

              {/* Dropdown */}
              {showDropdown && searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-xl shadow-xl overflow-hidden max-h-64 overflow-y-auto">
                  {usingCachedProducts && (
                    <div className="flex items-center gap-1.5 px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
                      <Database className="w-3 h-3 shrink-0" />
                      Showing cached data — server unreachable
                    </div>
                  )}
                  {searchResults.map((p) => {
                    const outOfStock = p.totalStock <= 0
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={outOfStock}
                        onClick={() => selectProduct(p)}
                        className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors border-b last:border-b-0 ${outOfStock ? 'cursor-not-allowed bg-zinc-50/70' : 'hover:bg-zinc-50 cursor-pointer'}`}
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-zinc-900 text-sm truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            {p.itemCode}{p.brand ? ` · ${p.brand}` : ''}
                          </p>
                        </div>
                        <div className="ml-4 text-right shrink-0">
                          <p className="font-semibold text-zinc-900 text-sm">₹{fmt(p.sellingRate)}</p>
                          {outOfStock ? (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-600 text-[10px] font-semibold uppercase tracking-wide">
                              No stock
                            </span>
                          ) : (
                            <p className="text-xs mt-0.5 text-emerald-600">
                              {formatQtyWithUnit(p.totalStock, p.unitOfMeasure)}
                            </p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
              {showDropdown && search && !searchLoading && searchResults.length === 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-xl shadow-xl px-4 py-5 text-center text-sm text-muted-foreground">
                  No products found for "{search}"
                </div>
              )}
            </div>

            {/* Quantity prompt — shown after selecting a product */}
            {pendingProduct && (
              <div className="mt-2 flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-zinc-900 bg-zinc-50">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-zinc-900 text-sm truncate">{pendingProduct.name}</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    ₹{fmt(pendingProduct.sellingRate)} · {formatQtyWithUnit(pendingProduct.totalStock, pendingProduct.unitOfMeasure)} in stock
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-xs font-semibold text-zinc-600 whitespace-nowrap">
                    {isLengthMode(pendingProduct.sellMode) ? 'Length:' : 'Qty:'}
                  </label>
                  <div className="relative">
                    <input
                      ref={pendingQtyRef}
                      type="number"
                      min={qtyStep(pendingProduct.sellMode)}
                      max={pendingProduct.totalStock}
                      step={qtyStep(pendingProduct.sellMode)}
                      value={pendingQty}
                      onChange={(e) => setPendingQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmAddToCart()
                        if (e.key === 'Escape') setPendingProduct(null)
                      }}
                      className={`h-9 pl-3 text-sm font-semibold text-center rounded-lg border-2 border-zinc-300 focus:border-zinc-900 focus:outline-none bg-white tabular-nums ${isLengthMode(pendingProduct.sellMode) ? 'w-28 pr-9' : 'w-20 pr-3'}`}
                    />
                    {isLengthMode(pendingProduct.sellMode) && (
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                        {pendingProduct.unitOfMeasure}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={confirmAddToCart}
                    className="h-9 px-3 text-sm font-semibold bg-zinc-900 hover:bg-zinc-800 text-white"
                  >
                    Add ↵
                  </Button>
                  <button
                    type="button"
                    onClick={() => setPendingProduct(null)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Cart items */}
          {cartItems.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center p-8">
              <ShoppingCart className="w-10 h-10 text-zinc-300 mb-3" strokeWidth={1.5} />
              <p className="text-sm font-medium text-zinc-500">Search a product above to start billing</p>
              <p className="text-xs text-muted-foreground mt-1">Items will appear here once added</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2.5 font-semibold text-zinc-600 w-6">#</th>
                    <th className="text-left px-3 py-2.5 font-semibold text-zinc-600">Product</th>
                    <th className="text-center px-2 py-2.5 font-semibold text-zinc-600 w-24">Qty</th>
                    <th className="text-right px-2 py-2.5 font-semibold text-zinc-600 w-20">Rate</th>
                    <th className="text-center px-2 py-2.5 font-semibold text-zinc-600 w-36">Discount</th>
                    <th className="text-right px-2 py-2.5 font-semibold text-zinc-600 w-20">Total</th>
                    <th className="w-8 px-1 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {cartItems.map((it, idx) => (
                    <tr key={it.productId + idx} className="hover:bg-zinc-50/60 group">
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{idx + 1}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-zinc-900 text-sm">{it.productName}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{it.itemCode}</p>
                      </td>
                      <td className="px-2 py-2.5">
                        {isLengthMode(it.sellMode) ? (
                          <div className="flex items-center justify-center gap-1">
                            <input
                              type="number"
                              min={qtyStep(it.sellMode)}
                              max={it.maxQty}
                              step={qtyStep(it.sellMode)}
                              value={qtyDraft?.idx === idx ? qtyDraft.value : formatQty(it.quantity)}
                              onChange={(e) => setQtyDraft({ idx, value: e.target.value })}
                              onBlur={(e) => commitQtyDraft(idx, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur()
                                if (e.key === 'Escape') setQtyDraft(null)
                              }}
                              className="w-16 h-7 px-1.5 text-xs font-semibold text-right rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring tabular-nums"
                            />
                            <span className="text-xs text-muted-foreground">{it.unitOfMeasure}</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => updateQty(idx, -1)}
                              disabled={it.quantity <= qtyStep(it.sellMode)}
                              className="w-6 h-6 rounded-md border flex items-center justify-center hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="w-7 text-center font-semibold tabular-nums text-sm">{formatQty(it.quantity)}</span>
                            <button
                              type="button"
                              onClick={() => updateQty(idx, 1)}
                              disabled={it.quantity >= it.maxQty}
                              className="w-6 h-6 rounded-md border flex items-center justify-center hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                        {it.quantity >= it.maxQty && (
                          <p className="text-center text-xs text-amber-600 mt-0.5">max</p>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right font-medium text-zinc-800 text-sm">
                        ₹{fmt(it.unitRate)}
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-1">
                          <div className="relative flex-1">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={it.lineDiscountPct || ''}
                              onChange={(e) => updateDiscount(idx, 'lineDiscountPct', e.target.value)}
                              placeholder="0"
                              className="w-full pl-5 pr-1 h-7 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring text-right"
                            />
                          </div>
                          <span className="text-zinc-300 text-xs">/</span>
                          <div className="relative flex-1">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                            <input
                              type="number"
                              min="0"
                              value={it.lineDiscountAmt || ''}
                              onChange={(e) => updateDiscount(idx, 'lineDiscountAmt', e.target.value)}
                              placeholder="0"
                              className="w-full pl-5 pr-1 h-7 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring text-right"
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-right font-bold text-zinc-900 text-sm">
                        ₹{fmt(it.lineTotal)}
                        {it.gstPercentage > 0 && (
                          <p className="text-xs text-muted-foreground font-normal">
                            incl. {it.gstPercentage}% GST
                          </p>
                        )}
                      </td>
                      <td className="px-1 py-2.5">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="w-6 h-6 rounded-md flex items-center justify-center text-zinc-300 hover:bg-red-50 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <div className="w-[340px] shrink-0 flex flex-col gap-3">

          {/* Order Summary */}
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">
              Order Summary
            </p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{cartItems.length} item{cartItems.length !== 1 ? 's' : ''}</span>
                <span>₹{fmt(subtotal)}</span>
              </div>
              {billDiscAmt > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span>Discount</span>
                  <span>−₹{fmt(billDiscAmt)}</span>
                </div>
              )}
              {/* Rates are GST-inclusive, so tax is extracted from the total
                  rather than added to it. */}
              <div className="flex justify-between text-muted-foreground">
                <span>Taxable value</span>
                <span>₹{fmt(taxableValue)}</span>
              </div>
              {totalGst > 0 && (
                <>
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>CGST</span>
                    <span>₹{fmt(cgstAmount)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>SGST</span>
                    <span>₹{fmt(sgstAmount)}</span>
                  </div>
                </>
              )}
            </div>

            {/* Bill discount */}
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs font-semibold text-zinc-600 mb-2">Bill Discount</p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    min="0"
                    value={billDiscountFlat}
                    onChange={(e) => { setBillDiscountFlat(e.target.value); setBillDiscountPct('') }}
                    placeholder="Flat"
                    className="pl-7 h-8 text-sm"
                  />
                </div>
                <div className="relative flex-1">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={billDiscountPct}
                    onChange={(e) => { setBillDiscountPct(e.target.value); setBillDiscountFlat('') }}
                    placeholder="0 %"
                    className="pr-7 h-8 text-sm"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
              </div>
              {billDiscAmt > 0 && billDiscPct > 0 && (
                <p className="text-xs text-emerald-600 mt-1.5">{billDiscPct}% → −₹{fmt(billDiscAmt)}</p>
              )}
            </div>

            {/* Grand total */}
            <div className="mt-3 pt-3 border-t flex items-center justify-between">
              <span className="font-bold text-zinc-900">Total</span>
              <span className="text-2xl font-bold text-zinc-900">₹{fmt(grandTotal)}</span>
            </div>
          </div>

          {/* Payment */}
          <div className="rounded-xl border bg-card p-4 flex flex-col gap-3">
            <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Payment</p>

            {/* Tender lines — one cash line covers the common case and tracks
                the bill total; splitting is one tap away. */}
            <div className="space-y-2">
              {tenderLines.map((t, idx) => (
                <div key={t.id} className="space-y-1.5">
                  <div className="flex gap-1.5">
                    <select
                      value={t.method}
                      onChange={(e) => updateTender(idx, { method: e.target.value as PaymentMethod })}
                      className="h-10 rounded-lg border border-zinc-200 bg-white px-2 text-sm font-semibold text-zinc-700 focus:outline-none focus:border-zinc-900"
                    >
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">₹</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={t.amount}
                        onChange={(e) => updateTender(idx, { amount: e.target.value })}
                        placeholder={fmt(grandTotal)}
                        className="pl-8 h-10 text-base font-medium"
                      />
                    </div>
                    {tenderLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeTender(idx)}
                        className="w-9 h-10 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="Remove this payment"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {NEEDS_REFERENCE.includes(t.method) && (
                    <Input
                      value={t.reference}
                      onChange={(e) => updateTender(idx, { reference: e.target.value })}
                      placeholder={t.method === 'CHEQUE' ? 'Cheque number' : 'Reference'}
                      className="h-9 text-sm font-mono"
                    />
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addTender}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed text-xs font-semibold text-muted-foreground hover:bg-zinc-50 hover:text-zinc-700 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Split payment
              </button>
            </div>

            {/* Quick tender amounts for a lone cash line */}
            {grandTotal > 0 && tenderLines.length === 1 && tenderLines[0].method === 'CASH' && (
              <div className="flex gap-1 flex-wrap">
                {[grandTotal, Math.ceil(grandTotal / 10) * 10, Math.ceil(grandTotal / 50) * 50, Math.ceil(grandTotal / 100) * 100]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .slice(0, 4)
                  .map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => updateTender(0, { amount: String(amt) })}
                      className="px-2 py-1 rounded-md border text-xs font-medium hover:bg-zinc-100 transition-colors"
                    >
                      ₹{fmt(amt)}
                    </button>
                  ))}
              </div>
            )}

            {change > 0 && (
              <div className="flex items-center justify-between p-2.5 rounded-lg text-sm font-semibold bg-emerald-50 text-emerald-800">
                <span>Change to return</span>
                <span>₹{fmt(change)}</span>
              </div>
            )}
            {balanceDue > 0 && (
              <div className="flex items-center justify-between p-2.5 rounded-lg text-sm font-semibold bg-orange-50 text-orange-800">
                <span>Balance due</span>
                <span>₹{fmt(balanceDue)}</span>
              </div>
            )}

            {/* Credit position. Offline these numbers are only as fresh as the
                last sync, so they are labelled rather than presented as fact. */}
            {balanceDue > 0 && (
              creditCheck.reason === 'NO_CUSTOMER' ? (
                <div className="p-2.5 rounded-lg bg-amber-50 text-amber-800 text-xs">
                  Attach a customer before leaving a balance — a walk-in bill has to be paid in full.
                </div>
              ) : (
                <div className={`p-2.5 rounded-lg text-xs ${creditCheck.allowed ? 'bg-zinc-50 text-zinc-600' : 'bg-amber-50 text-amber-800'}`}>
                  <div className="flex justify-between">
                    <span>Already owes</span>
                    <span className="font-semibold">₹{fmt(currentOutstanding)}</span>
                  </div>
                  <div className="flex justify-between mt-0.5">
                    <span>Credit available</span>
                    <span className="font-semibold">₹{fmt(availableCredit)}</span>
                  </div>
                  {customerFiguresStale && (
                    <p className="mt-1 text-[11px] text-zinc-500">As of the last sync.</p>
                  )}
                  {!creditCheck.allowed && (
                    <p className="mt-1.5 font-semibold">
                      {creditCheck.reason === 'NO_CREDIT_ALLOWED'
                        ? 'This customer has no credit limit. Ask a manager.'
                        : `Over their limit by ₹${fmt(creditCheck.overBy)}. Ask a manager.`}
                    </p>
                  )}
                </div>
              )
            )}

            {submitError && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">{submitError}</div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-2">
              <Button
                onClick={handlePay}
                disabled={!canPay || submitting || cartItems.length === 0}
                className="h-11 text-sm font-bold gap-2 w-full"
              >
                {submitting ? (
                  <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Processing...</>
                ) : (
                  <><CheckCircle2 className="w-4 h-4" /> Collect ₹{fmt(grandTotal)}</>
                )}
              </Button>
              <button
                type="button"
                onClick={() => {
                  if (cartItems.length === 0 || confirm('Clear the current bill?')) {
                    setCartItems([])
                    setQtyDraft(null)
                    setBillDiscountFlat('')
                    setBillDiscountPct('')
                    resetTenders()
                    setSubmitError('')
                  }
                }}
                className="text-xs text-muted-foreground hover:text-red-600 transition-colors text-center py-1"
              >
                Clear Bill
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Rejected bills. These sales exist on this till and nowhere else:
          the server refused them and the queue stopped retrying. Somebody has
          to reconcile each one by hand, so the till has to name them. */}
      <Modal
        open={showFailedModal}
        onClose={() => setShowFailedModal(false)}
        title="Rejected sales"
        size="md"
      >
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
            These bills were taken on this till but the branch server refused
            them, so they are <span className="font-semibold">not in the books</span>.
            Fix the cause and retry, or note them down and tell the manager.
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {failedBills.map((b) => {
              const d = (b.display ?? {}) as Partial<PendingBillDisplay>
              return (
                <div key={b.clientLocalId} className="p-3 rounded-lg border bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">
                        ₹{fmt(Number(d.grandTotal ?? 0))}
                        <span className="ml-2 font-normal text-xs text-muted-foreground">
                          {d.itemCount ?? 0} item{d.itemCount === 1 ? '' : 's'} · {d.paymentMethod ?? '—'}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(b.createdAt).toLocaleString('en-IN')} · {b.attempts} attempt
                        {b.attempts === 1 ? '' : 's'}
                      </p>
                      <p className="text-xs font-mono text-red-700 mt-1 break-words">
                        {b.lastError ?? 'Rejected'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="h-8 text-xs shrink-0"
                      disabled={retryingId === b.clientLocalId}
                      onClick={async () => {
                        setRetryingId(b.clientLocalId)
                        try {
                          await window.api.db.bill.retryFailed(b.clientLocalId)
                          await syncPendingBills()
                        } finally {
                          setRetryingId(null)
                        }
                      }}
                    >
                      {retryingId === b.clientLocalId ? 'Retrying…' : 'Retry'}
                    </Button>
                  </div>
                </div>
              )
            })}
            {failedBills.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Nothing rejected. Every sale reached the server.
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* Customer Modal */}
      <Modal
        open={showCustomerModal}
        onClose={() => { setShowCustomerModal(false); resetCustomerModal() }}
        title="Attach Customer"
        size="sm"
      >
        <div className="space-y-4">
          {!showAddCustomer ? (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search by name or phone..."
                  className="pl-9 h-10"
                  autoFocus
                />
              </div>

              {customerSearchLoading && (
                <div className="flex justify-center py-4">
                  <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
                </div>
              )}

              {!customerSearchLoading && customerSearch && customerResults.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-3">No customers found.</p>
              )}

              {customerResults.length > 0 && (
                <div className="rounded-lg border overflow-hidden divide-y max-h-48 overflow-y-auto">
                  {customerResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setCustomer(c); setShowCustomerModal(false); resetCustomerModal() }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0 font-bold text-zinc-600 text-sm uppercase">
                        {c.name.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-sm text-zinc-900">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.phone}</p>
                      </div>
                      <ChevronDown className="w-4 h-4 text-zinc-300 ml-auto -rotate-90" />
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowAddCustomer(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed text-sm text-muted-foreground hover:bg-zinc-50 hover:text-zinc-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add New Customer
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowAddCustomer(false)}
                className="text-xs text-muted-foreground hover:text-zinc-700 transition-colors flex items-center gap-1"
              >
                ← Back to search
              </button>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">Name *</label>
                  <Input
                    value={newCustomerName}
                    onChange={(e) => { setNewCustomerName(e.target.value); setNewCustomerError('') }}
                    placeholder="Customer name"
                    className="h-9"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">Phone *</label>
                  <Input
                    value={newCustomerPhone}
                    onChange={(e) => { setNewCustomerPhone(e.target.value); setNewCustomerError('') }}
                    placeholder="98765 43210"
                    className="h-9 font-mono"
                  />
                </div>
                {newCustomerError && (
                  <p className="text-xs text-red-600">{newCustomerError}</p>
                )}
                <Button onClick={handleAddCustomer} className="w-full h-9 text-sm">
                  Add Customer
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}
