import { useState, useEffect, useRef } from 'react'
import {
  Search, ArrowLeft, RotateCcw, Printer, CheckCircle2, AlertTriangle,
  CloudOff, User, Plus, Minus, Receipt
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal } from './ui/modal'
import { printReceipt, type ReceiptBill, type ReceiptShop } from '../lib/receipt'
import { round2 } from '@shared/money'
import {
  RETURN_REASONS, shouldRestock, isReturnReasonCode, type ReturnReasonCode
} from '@shared/procurement'
import {
  parseQty, qtyStep, formatQty, formatQtyWithUnit, roundQty,
  LENGTH_MEASURES, type SellMode
} from '@shared/units'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A row from GET /api/v1/bills — enough to pick the right invoice. */
type BillSummary = {
  id: string
  billNumber: string
  status: string
  paidAt: string | null
  totalAmount: number
  balanceDue: number
  paymentMethod: string
  customer: { name: string } | null
  _count: { items: number }
}

type BillDetailItem = {
  id: string
  itemCode: string
  productName: string
  unitOfMeasure: string
  quantity: number
  unitRate: number
  lineTotal: number
  gstPercentage: number
  /** Cumulative quantity already refunded against this exact line. */
  alreadyReturnedQty: number
}

type BillDetail = {
  id: string
  billNumber: string
  status: string
  paidAt: string | null
  subtotal: number
  discountAmount: number
  totalAmount: number
  paidAmount: number
  balanceDue: number
  paymentMethod: string
  customer: { name: string } | null
  items: BillDetailItem[]
  returns: {
    id: string
    billNumber: string
    totalAmount: number
    paidAt: string | null
    returnReason: string | null
  }[]
}

/** The credit note the server hands back from POST /bills/:id/return. */
type CreditNote = {
  id: string
  billNumber: string
  paidAt?: string
  paymentMethod: string
  subtotal?: number
  gstAmount?: number
  discountAmount?: number
  totalAmount: number
  taxableValue?: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  status?: string
  items: {
    itemCode?: string
    productName: string
    unitOfMeasure?: string
    quantity: number
    unitRate?: number
    lineTotal: number
    gstPercentage?: number
    taxableValue?: number
    cgstAmount?: number
    sgstAmount?: number
    igstAmount?: number
    billDiscountAmt?: number
  }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

/**
 * A bill line records the unit of measure it was sold in but not the product's
 * sell mode, so we infer it: anything measured in a length unit is cut to
 * length, and so is any line whose sold quantity isn't whole (weighed goods).
 * Getting this wrong would floor a 2.5 m return down to 2 m.
 */
function lineSellMode(it: BillDetailItem): SellMode {
  const uom = (it.unitOfMeasure || '').toLowerCase()
  if ((LENGTH_MEASURES as readonly string[]).includes(uom)) return 'LENGTH'
  return Number.isInteger(it.quantity) ? 'UNIT' : 'LENGTH'
}

/** What is still refundable on a line. */
function remainingQty(it: BillDetailItem): number {
  return roundQty(Math.max(0, it.quantity - (it.alreadyReturnedQty || 0)))
}

/**
 * The server pro-rates each line by the fraction returned, then apportions the
 * bill-level discount over that. Mirroring the same arithmetic here means the
 * figure on screen is the figure on the credit note, not an approximation.
 */
function estimateRefund(
  bill: BillDetail,
  picks: { item: BillDetailItem; qty: number }[]
): { gross: number; discount: number; net: number } {
  const gross = round2(
    picks.reduce(
      (s, p) => s + (p.item.quantity > 0 ? round2(p.item.lineTotal * (p.qty / p.item.quantity)) : 0),
      0
    )
  )
  const origSubtotal = Number(bill.subtotal) || 0
  const origDiscount = Number(bill.discountAmount) || 0
  const discount = origSubtotal > 0 ? round2(origDiscount * (gross / origSubtotal)) : 0
  return { gross, discount, net: round2(gross - discount) }
}

const STATUS_STYLE: Record<string, string> = {
  PAID: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PARTIAL: 'bg-amber-50 text-amber-700 border-amber-200',
  CREDIT: 'bg-orange-50 text-orange-700 border-orange-200',
  RETURN: 'bg-sky-50 text-sky-700 border-sky-200',
  VOID: 'bg-zinc-100 text-zinc-500 border-zinc-200'
}

const STATUS_LABEL: Record<string, string> = {
  PAID: 'Paid',
  PARTIAL: 'Part paid',
  CREDIT: 'On credit',
  RETURN: 'Credit note',
  VOID: 'Voided'
}

/** Returns are only possible against a bill the server will accept. */
const RETURNABLE_STATUSES = ['PAID', 'PARTIAL', 'CREDIT']

function StatusPill({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold uppercase tracking-wide ${
        STATUS_STYLE[status] ?? 'bg-zinc-100 text-zinc-600 border-zinc-200'
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { hour12: true })
}

// ─── ReturnsScreen ────────────────────────────────────────────────────────────

export default function ReturnsScreen(): React.JSX.Element {
  const ip = localStorage.getItem('mainServerIp') || ''
  const port = localStorage.getItem('mainServerPort') || '52001'
  const apiBase = `http://${ip}:${port}`
  const token = localStorage.getItem('cashierToken')
  const deviceId = localStorage.getItem('terminalDeviceId') || ''

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

  /**
   * A thrown error with no `status` never reached the server — the fetch itself
   * failed. Returns need the server to work out which batches the goods go back
   * into, so there is nothing sensible to queue offline; we say so instead.
   */
  const isOffline = (err: unknown): boolean => (err as { status?: number }).status === undefined

  // Search
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<BillSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [offline, setOffline] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Selected bill
  const [bill, setBill] = useState<BillDetail | null>(null)
  const [loadingBill, setLoadingBill] = useState(false)

  // Picked quantities — kept as raw strings so a decimal point stays typable
  // mid-keystroke, exactly as the billing cart does.
  const [picked, setPicked] = useState<Record<string, string>>({})

  // Reason
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode | ''>('')
  const [note, setNote] = useState('')

  // Confirm + submit
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [creditNote, setCreditNote] = useState<CreditNote | null>(null)

  // Receipt
  const [shopInfo, setShopInfo] = useState<ReceiptShop>({ name: 'My Shop' })
  const [printingState, setPrintingState] = useState<'idle' | 'printing' | 'error'>('idle')
  const [printError, setPrintError] = useState('')
  const printedOnce = useRef(false)

  const cashierName = (() => {
    try { return localStorage.getItem('cashierUsername') || undefined } catch { return undefined }
  })()

  // Shop details for the credit-note header, same source BillingScreen uses.
  useEffect(() => {
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

  // ─── Find the bill ───────────────────────────────────────────────────────

  const runSearch = async (): Promise<void> => {
    const q = search.trim()
    if (!q) return
    setSearching(true)
    setSearchError('')
    setOffline(false)
    try {
      const d = await apiFetch<{ bills: BillSummary[]; total: number }>(
        `/api/v1/bills?search=${encodeURIComponent(q)}&limit=25&offset=0`
      )
      setResults(d.bills || [])
      setSearched(true)
    } catch (err: unknown) {
      setResults([])
      setSearched(true)
      if (isOffline(err)) {
        setOffline(true)
        setSearchError('')
      } else {
        setSearchError('Could not look up bills. Please try again.')
      }
    } finally {
      setSearching(false)
    }
  }

  const openBill = async (summary: BillSummary): Promise<void> => {
    setLoadingBill(true)
    setSubmitError('')
    setOffline(false)
    try {
      const d = await apiFetch<{ bill: BillDetail }>(`/api/v1/bills/${summary.id}`)
      setBill(d.bill)
      setPicked({})
      setReasonCode('')
      setNote('')
    } catch (err: unknown) {
      if (isOffline(err)) setOffline(true)
      else setSearchError('Could not open that bill. Please try again.')
    } finally {
      setLoadingBill(false)
    }
  }

  const backToSearch = (): void => {
    setBill(null)
    setPicked({})
    setReasonCode('')
    setNote('')
    setSubmitError('')
  }

  const startAnother = (): void => {
    setCreditNote(null)
    setBill(null)
    setPicked({})
    setReasonCode('')
    setNote('')
    setSubmitError('')
    setSearch('')
    setResults([])
    setSearched(false)
    setPrintError('')
    setPrintingState('idle')
    printedOnce.current = false
    setTimeout(() => searchInputRef.current?.focus(), 50)
  }

  // ─── Line selection ──────────────────────────────────────────────────────

  const setLineQty = (it: BillDetailItem, raw: string): void => {
    setPicked((prev) => {
      const next = { ...prev }
      if (raw === '') delete next[it.id]
      else next[it.id] = raw
      return next
    })
  }

  /** Commits a typed quantity: parsed for the line's unit, clamped to what's left. */
  const commitLineQty = (it: BillDetailItem): void => {
    const raw = picked[it.id]
    if (raw == null || raw === '') return
    const mode = lineSellMode(it)
    const parsed = parseQty(raw, mode)
    const max = remainingQty(it)
    if (parsed <= 0) {
      setPicked((prev) => {
        const next = { ...prev }
        delete next[it.id]
        return next
      })
      return
    }
    const clamped = roundQty(Math.min(parsed, max))
    setPicked((prev) => ({ ...prev, [it.id]: formatQty(clamped) }))
  }

  const bumpLineQty = (it: BillDetailItem, direction: 1 | -1): void => {
    const mode = lineSellMode(it)
    const step = qtyStep(mode)
    const max = remainingQty(it)
    const current = parseQty(picked[it.id] ?? '0', mode)
    // Stepping a cut-length line by 0.001 would be useless at a touch till, so
    // the buttons move a whole unit and the keypad handles the fine detail.
    const delta = mode === 'LENGTH' ? 1 : step
    const nextVal = roundQty(current + delta * direction)
    if (nextVal < step) {
      setPicked((prev) => {
        const next = { ...prev }
        delete next[it.id]
        return next
      })
      return
    }
    setPicked((prev) => ({ ...prev, [it.id]: formatQty(Math.min(nextVal, max)) }))
  }

  const returnEverything = (): void => {
    if (!bill) return
    const next: Record<string, string> = {}
    for (const it of bill.items) {
      const rem = remainingQty(it)
      if (rem > 0) next[it.id] = formatQty(rem)
    }
    setPicked(next)
  }

  // Lines the cashier has actually picked, with parsed + clamped quantities.
  const picks = (bill?.items ?? [])
    .map((it) => {
      const mode = lineSellMode(it)
      const qty = roundQty(Math.min(parseQty(picked[it.id] ?? '0', mode), remainingQty(it)))
      return { item: it, qty }
    })
    .filter((p) => p.qty > 0)

  const refund = bill ? estimateRefund(bill, picks) : { gross: 0, discount: 0, net: 0 }
  const restocks = reasonCode ? shouldRestock(reasonCode) : true
  const balanceDue = Number(bill?.balanceDue ?? 0)
  const unsettled = balanceDue > 0
  // On an unsettled bill the refund is knocked off the outstanding balance
  // first; only what's left over is cash the customer actually gets back.
  const offBalance = unsettled ? Math.min(refund.net, balanceDue) : 0
  const cashBack = round2(refund.net - offBalance)

  const canSubmit =
    !!bill &&
    RETURNABLE_STATUSES.includes(bill.status) &&
    picks.length > 0 &&
    isReturnReasonCode(reasonCode) &&
    !submitting

  // ─── Submit ──────────────────────────────────────────────────────────────

  const submitReturn = async (): Promise<void> => {
    if (!bill || !canSubmit) return
    setSubmitting(true)
    setSubmitError('')
    setOffline(false)
    try {
      const d = await apiFetch<{ bill: CreditNote }>(`/api/v1/bills/${bill.id}/return`, {
        method: 'POST',
        body: JSON.stringify({
          items: picks.map((p) => ({ billItemId: p.item.id, quantity: p.qty })),
          reasonCode,
          reason: note.trim() || undefined,
          originDeviceId: deviceId
        })
      })
      setShowConfirm(false)
      setCreditNote(d.bill)
    } catch (err: unknown) {
      const e = err as {
        status?: number
        data?: { error?: string; message?: string; requested?: number; remaining?: number }
      }
      if (isOffline(err)) {
        setOffline(true)
        setSubmitError('')
        setShowConfirm(false)
      } else if (e.data?.error === 'RETURN_QTY_EXCEEDS_REMAINING') {
        setSubmitError(
          e.data.message ||
            `Only ${formatQty(e.data.remaining ?? 0)} of that line is still returnable — ` +
              `${formatQty(e.data.requested ?? 0)} was asked for. Reopen the bill to see the current figures.`
        )
      } else if (e.data?.error === 'ORIGINAL_NOT_PAID') {
        setSubmitError(
          e.data.message || 'This bill cannot be returned against in its current state.'
        )
      } else if (e.data?.error === 'BILL_ITEM_NOT_IN_ORIGINAL') {
        setSubmitError(
          e.data.message || 'One of the lines is no longer part of this bill. Reopen it and try again.'
        )
      } else if (e.data?.error === 'INVALID_RETURN_REASON') {
        setSubmitError(e.data.message || 'Pick one of the listed return reasons.')
      } else if (e.data?.error === 'RETURN_ITEMS_REQUIRED') {
        setSubmitError(e.data.message || 'Pick at least one line to return.')
      } else if (e.data?.error === 'LICENSE_LOCKED') {
        setSubmitError(
          `${e.data.message || 'This branch licence is locked.'} Ask a manager before taking the goods back.`
        )
      } else {
        setSubmitError(e.data?.message || 'The return could not be recorded. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Printing ────────────────────────────────────────────────────────────

  const handlePrint = async (): Promise<void> => {
    if (!creditNote) return
    setPrintingState('printing')
    setPrintError('')
    const payload: ReceiptBill = {
      billNumber: creditNote.billNumber,
      paidAt: creditNote.paidAt,
      paymentMethod: creditNote.paymentMethod,
      subtotal: creditNote.subtotal,
      gstAmount: creditNote.gstAmount,
      discountAmount: creditNote.discountAmount,
      totalAmount: creditNote.totalAmount,
      taxableValue: creditNote.taxableValue,
      cgstAmount: creditNote.cgstAmount,
      sgstAmount: creditNote.sgstAmount,
      igstAmount: creditNote.igstAmount,
      // Always RETURN — this prints as a credit note, never as a sale.
      status: 'RETURN',
      customerName: bill?.customer?.name ?? null,
      cashierName,
      items: creditNote.items.map((it) => ({
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
    }
    const r = await printReceipt(shopInfo, payload, printedOnce.current ? { copyLabel: 'REPRINT' } : {})
    printedOnce.current = true
    if (r.ok) setPrintingState('idle')
    else { setPrintingState('error'); setPrintError(r.error || 'Print failed') }
  }

  // ─── Offline banner ──────────────────────────────────────────────────────

  const offlineBanner = offline && (
    <div className="flex items-start gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm">
      <CloudOff className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold text-amber-900">Branch server unreachable</p>
        <p className="text-amber-800 text-xs mt-0.5 max-w-xl">
          Returns can&apos;t be taken while this terminal is offline — the server has to work out
          which batches the goods go back into, so nothing is being saved or queued here. Reconnect
          and try again, or ask the customer to come back once the till is online.
        </p>
      </div>
    </div>
  )

  // ─── Success ─────────────────────────────────────────────────────────────

  if (creditNote) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-6 text-center p-8">
        <div className="w-20 h-20 rounded-full bg-sky-100 flex items-center justify-center">
          <CheckCircle2 className="w-11 h-11 text-sky-600" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">Return Recorded</h2>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{creditNote.billNumber}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Credit note against {bill?.billNumber ?? 'the original bill'}
          </p>
        </div>

        <div className="border rounded-xl p-6 w-full max-w-sm text-left space-y-2 bg-zinc-50">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {unsettled ? 'Credited' : 'Refund'}
            </span>
            <span className="font-bold text-lg">₹{fmt(creditNote.totalAmount)}</span>
          </div>
          {unsettled && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {offBalance > 0 && (
                <>₹{fmt(offBalance)} comes off what the customer owes on {bill?.billNumber}. </>
              )}
              {cashBack > 0
                ? <>Hand back ₹{fmt(cashBack)}.</>
                : <>No cash changes hands.</>}
            </p>
          )}
          {!restocks && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Recorded as unsellable — the goods have <strong>not</strong> gone back into stock.
            </p>
          )}
          <div className="border-t pt-3 mt-2 space-y-1">
            {creditNote.items?.map((it, i) => (
              <div key={i} className="flex justify-between text-xs text-muted-foreground">
                <span>{it.productName} × {formatQty(it.quantity)}</span>
                <span>₹{fmt(it.lineTotal)}</span>
              </div>
            ))}
          </div>
        </div>

        {printError && <p className="text-xs text-red-600">Print: {printError}</p>}

        <div className="flex gap-3 flex-wrap justify-center">
          <Button
            variant="outline"
            onClick={handlePrint}
            disabled={printingState === 'printing'}
            className="gap-2 h-12 px-6 text-base"
          >
            <Printer className="w-4 h-4" />
            {printingState === 'printing'
              ? 'Printing…'
              : printedOnce.current ? 'Reprint Credit Note' : 'Print Credit Note'}
          </Button>
          <Button onClick={startAnother} className="gap-2 h-12 px-8 text-base">
            <RotateCcw className="w-4 h-4" /> Process Another Return
          </Button>
        </div>
      </div>
    )
  }

  // ─── Bill detail + line picking ──────────────────────────────────────────

  if (bill) {
    const returnable = RETURNABLE_STATUSES.includes(bill.status)
    const anythingLeft = bill.items.some((it) => remainingQty(it) > 0)

    return (
      <div className="flex flex-col flex-1 p-4 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="outline" onClick={backToSearch} className="h-11 px-4 gap-2 shrink-0">
              <ArrowLeft className="w-4 h-4" /> Back
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold flex items-center gap-2">
                <Receipt className="w-5 h-5 shrink-0" />
                <span className="font-mono truncate">{bill.billNumber}</span>
                <StatusPill status={bill.status} />
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {dateLabel(bill.paidAt)} · ₹{fmt(bill.totalAmount)} · {bill.paymentMethod}
                {bill.customer ? ` · ${bill.customer.name}` : ''}
              </p>
            </div>
          </div>
          {anythingLeft && returnable && (
            <Button variant="outline" onClick={returnEverything} className="h-11 px-4 gap-2 shrink-0">
              <RotateCcw className="w-4 h-4" /> Return Everything
            </Button>
          )}
        </div>

        {offlineBanner}

        {!returnable && (
          <div className="flex items-start gap-3 rounded-xl border-2 border-zinc-300 bg-zinc-50 px-4 py-3 text-sm mb-4">
            <AlertTriangle className="w-5 h-5 text-zinc-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-zinc-800">Nothing can be returned against this bill</p>
              <p className="text-zinc-600 text-xs mt-0.5">
                It is {STATUS_LABEL[bill.status] ?? bill.status.toLowerCase()}. Only paid, part-paid
                and credit bills can be returned against.
              </p>
            </div>
          </div>
        )}

        {unsettled && returnable && (
          <div className="flex items-start gap-3 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-sm mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-900">
                ₹{fmt(balanceDue)} is still owed on this bill
              </p>
              <p className="text-amber-800 text-xs mt-0.5">
                The refund comes off what the customer owes first. Only anything left over after
                that is cash handed back across the counter.
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-4 flex-1 min-h-0">
          {/* LEFT — lines */}
          <div className="flex-1 flex flex-col min-w-0 overflow-y-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-3 font-semibold text-zinc-600">Product</th>
                  <th className="text-right px-2 py-3 font-semibold text-zinc-600 w-24">Sold</th>
                  <th className="text-right px-2 py-3 font-semibold text-zinc-600 w-28">Returned</th>
                  <th className="text-right px-2 py-3 font-semibold text-zinc-600 w-28">Returnable</th>
                  <th className="text-center px-2 py-3 font-semibold text-zinc-600 w-52">
                    Coming back
                  </th>
                  <th className="text-right px-3 py-3 font-semibold text-zinc-600 w-24">Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bill.items.map((it) => {
                  const rem = remainingQty(it)
                  const mode = lineSellMode(it)
                  const done = rem <= 0
                  const raw = picked[it.id] ?? ''
                  const qty = roundQty(Math.min(parseQty(raw || '0', mode), rem))
                  const lineRefund =
                    qty > 0 && it.quantity > 0 ? round2(it.lineTotal * (qty / it.quantity)) : 0
                  return (
                    <tr
                      key={it.id}
                      className={done ? 'bg-zinc-50/70' : qty > 0 ? 'bg-sky-50/50' : ''}
                    >
                      <td className="px-3 py-3">
                        <p className={`font-medium text-sm ${done ? 'text-zinc-400' : 'text-zinc-900'}`}>
                          {it.productName}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">
                          {it.itemCode} · ₹{fmt(it.unitRate)}/{it.unitOfMeasure || 'pcs'}
                        </p>
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums text-zinc-700">
                        {formatQtyWithUnit(it.quantity, it.unitOfMeasure)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums text-zinc-500">
                        {it.alreadyReturnedQty > 0 ? formatQty(it.alreadyReturnedQty) : '—'}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums font-semibold text-zinc-800">
                        {done ? '—' : formatQty(rem)}
                      </td>
                      <td className="px-2 py-3">
                        {done ? (
                          <div className="text-center">
                            <span className="inline-block px-2 py-1 rounded-full bg-zinc-200 text-zinc-600 text-[11px] font-semibold uppercase tracking-wide">
                              Fully returned
                            </span>
                          </div>
                        ) : !returnable ? (
                          <div className="text-center text-xs text-muted-foreground">—</div>
                        ) : (
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => bumpLineQty(it, -1)}
                              className="w-11 h-11 flex items-center justify-center rounded-lg border-2 border-zinc-200 text-zinc-600 hover:bg-zinc-100 active:bg-zinc-200 transition-colors"
                              aria-label="Reduce quantity"
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <div className="relative">
                              <input
                                type="number"
                                min={0}
                                max={rem}
                                step={qtyStep(mode)}
                                value={raw}
                                placeholder="0"
                                onChange={(e) => setLineQty(it, e.target.value)}
                                onBlur={() => commitLineQty(it)}
                                onKeyDown={(e) => { if (e.key === 'Enter') commitLineQty(it) }}
                                className={`h-11 pl-3 text-base font-semibold text-center rounded-lg border-2 border-zinc-300 focus:border-zinc-900 focus:outline-none bg-white tabular-nums ${
                                  mode === 'LENGTH' ? 'w-28 pr-9' : 'w-20 pr-3'
                                }`}
                              />
                              {mode === 'LENGTH' && (
                                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                                  {it.unitOfMeasure}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => bumpLineQty(it, 1)}
                              className="w-11 h-11 flex items-center justify-center rounded-lg border-2 border-zinc-200 text-zinc-600 hover:bg-zinc-100 active:bg-zinc-200 transition-colors"
                              aria-label="Increase quantity"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold">
                        {lineRefund > 0 ? `₹${fmt(lineRefund)}` : <span className="text-zinc-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {bill.returns.length > 0 && (
              <div className="border-t bg-zinc-50 px-4 py-3">
                <p className="text-xs font-semibold text-zinc-600 mb-1.5">
                  Earlier credit notes on this bill
                </p>
                <div className="space-y-1">
                  {bill.returns.map((r) => (
                    <div key={r.id} className="flex justify-between text-xs text-muted-foreground">
                      <span className="font-mono">{r.billNumber} · {dateLabel(r.paidAt)}</span>
                      <span>₹{fmt(r.totalAmount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — reason + refund */}
          <div className="w-[26rem] shrink-0 flex flex-col gap-3 overflow-y-auto">
            {/* Reason picker */}
            <div className="rounded-xl border p-4">
              <p className="text-sm font-bold text-zinc-900 mb-0.5">Why is it coming back?</p>
              <p className="text-xs text-muted-foreground mb-3">Required — pick one.</p>
              <div className="grid grid-cols-1 gap-2">
                {RETURN_REASONS.map((r) => {
                  const active = reasonCode === r.code
                  return (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => setReasonCode(r.code)}
                      disabled={!returnable}
                      className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        active
                          ? 'border-zinc-900 bg-zinc-900 text-white'
                          : 'border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800'
                      }`}
                    >
                      <span className="block text-sm font-semibold">{r.label}</span>
                      {r.hint && (
                        <span
                          className={`block text-xs mt-0.5 ${active ? 'text-zinc-300' : 'text-muted-foreground'}`}
                        >
                          {r.hint}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              {reasonCode && !restocks && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2.5">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-800">
                    These goods will <strong>not</strong> go back into stock — they are recorded as
                    unsellable. The customer is still refunded in full; the shop takes the loss.
                  </p>
                </div>
              )}

              <label className="block mt-3">
                <span className="text-xs font-semibold text-zinc-600">Note (optional)</span>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={!returnable}
                  placeholder="Anything worth recording on the credit note…"
                  className="mt-1 h-11 text-sm"
                />
              </label>
            </div>

            {/* Refund summary */}
            <div className="rounded-xl border-2 border-zinc-900 p-4 bg-white">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {picks.length} line{picks.length !== 1 ? 's' : ''} selected
                </span>
                <span className="tabular-nums text-zinc-600">₹{fmt(refund.gross)}</span>
              </div>
              {refund.discount > 0 && (
                <div className="flex justify-between text-xs mt-1">
                  <span className="text-muted-foreground">Bill discount reversed</span>
                  <span className="tabular-nums text-zinc-600">−₹{fmt(refund.discount)}</span>
                </div>
              )}
              <div className="flex justify-between items-baseline border-t mt-3 pt-3">
                <span className="text-sm font-bold">
                  {unsettled ? 'Credit to customer' : 'Refund total'}
                </span>
                <span className="text-2xl font-bold tabular-nums">₹{fmt(refund.net)}</span>
              </div>
              {unsettled && refund.net > 0 && (
                <p className="text-xs text-amber-700 mt-2">
                  ₹{fmt(offBalance)} off the ₹{fmt(balanceDue)} outstanding
                  {cashBack > 0 ? `, ₹${fmt(cashBack)} back in cash` : ' — no cash back'}.
                </p>
              )}

              {submitError && (
                <p className="text-xs text-red-600 mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {submitError}
                </p>
              )}

              <Button
                onClick={() => { setSubmitError(''); setShowConfirm(true) }}
                disabled={!canSubmit}
                className="w-full mt-4 h-14 text-base gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                {picks.length === 0
                  ? 'Pick what is coming back'
                  : !isReturnReasonCode(reasonCode)
                    ? 'Pick a reason'
                    : `Return ₹${fmt(refund.net)}`}
              </Button>
            </div>
          </div>
        </div>

        {/* Confirm */}
        <Modal
          open={showConfirm}
          onClose={() => { if (!submitting) setShowConfirm(false) }}
          title="Confirm return"
          size="md"
        >
          <div className="space-y-4">
            <div className="rounded-xl border divide-y">
              {picks.map((p) => (
                <div key={p.item.id} className="flex justify-between items-center px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{p.item.productName}</p>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{p.item.itemCode}</p>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatQtyWithUnit(p.qty, p.item.unitOfMeasure)}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      ₹{fmt(p.item.quantity > 0 ? round2(p.item.lineTotal * (p.qty / p.item.quantity)) : 0)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-baseline">
              <span className="text-sm font-bold">
                {unsettled ? 'Credit to customer' : 'Refund total'}
              </span>
              <span className="text-2xl font-bold tabular-nums">₹{fmt(refund.net)}</span>
            </div>

            <div className="text-sm text-zinc-700 bg-zinc-50 border rounded-xl px-4 py-3 space-y-1">
              <p>
                <span className="text-muted-foreground">Reason: </span>
                <span className="font-medium">
                  {RETURN_REASONS.find((r) => r.code === reasonCode)?.label ?? '—'}
                </span>
              </p>
              {note.trim() && (
                <p>
                  <span className="text-muted-foreground">Note: </span>
                  <span className="font-medium">{note.trim()}</span>
                </p>
              )}
            </div>

            {unsettled ? (
              <div className="flex items-start gap-2 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">
                  This bill still has ₹{fmt(balanceDue)} outstanding, so this is not a cash refund.
                  ₹{fmt(offBalance)} comes off what the customer owes
                  {cashBack > 0
                    ? `, and ₹${fmt(cashBack)} is handed back in cash.`
                    : ' — no money changes hands at the counter.'}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border bg-zinc-50 px-4 py-3">
                <User className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
                <p className="text-xs text-zinc-700">
                  ₹{fmt(refund.net)} goes back to the customer.
                </p>
              </div>
            )}

            {!restocks && (
              <div className="flex items-start gap-2 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-3">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <p className="text-xs text-red-800">
                  Recorded as unsellable — the goods will <strong>not</strong> be put back into
                  stock, and the customer is still refunded.
                </p>
              </div>
            )}

            {submitError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {submitError}
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                disabled={submitting}
                className="flex-1 h-12 text-base"
              >
                Cancel
              </Button>
              <Button onClick={submitReturn} disabled={submitting} className="flex-1 h-12 text-base gap-2">
                <RotateCcw className="w-4 h-4" />
                {submitting ? 'Recording…' : 'Confirm Return'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    )
  }

  // ─── Find a bill ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 p-4 min-h-0">
      <div className="mb-4">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <RotateCcw className="w-5 h-5" /> Returns
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Find the original bill, pick what is coming back, and record the credit note.
        </p>
      </div>

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground z-10" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch() } }}
            placeholder="Bill number or customer name…"
            className="pl-12 h-14 text-base"
            autoFocus
          />
          {searching && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
          )}
        </div>
        <Button
          onClick={runSearch}
          disabled={!search.trim() || searching}
          className="h-14 px-8 text-base gap-2"
        >
          <Search className="w-4 h-4" /> Find Bill
        </Button>
      </div>

      {offlineBanner}

      {searchError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
          {searchError}
        </p>
      )}

      {loadingBill && (
        <p className="text-sm text-muted-foreground px-1 mb-2">Opening bill…</p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border">
        {results.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-10">
            <Receipt className="w-10 h-10 text-zinc-300 mb-3" strokeWidth={1.5} />
            <p className="text-sm font-medium text-zinc-500">
              {searched && !offline && !searchError
                ? `No bills found for "${search.trim()}"`
                : 'Search for the bill the goods were sold on'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {searched && !offline && !searchError
                ? 'Check the bill number, or try the customer’s name.'
                : 'Type a bill number or the customer’s name above.'}
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {results.map((b) => {
              const returnable = RETURNABLE_STATUSES.includes(b.status)
              return (
                <button
                  key={b.id}
                  type="button"
                  disabled={!returnable || loadingBill}
                  onClick={() => openBill(b)}
                  className={`w-full flex items-center justify-between gap-4 px-5 py-4 text-left transition-colors ${
                    returnable
                      ? 'hover:bg-zinc-50 active:bg-zinc-100 cursor-pointer'
                      : 'bg-zinc-50/70 cursor-not-allowed'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-base text-zinc-900">
                        {b.billNumber}
                      </span>
                      <StatusPill status={b.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {dateLabel(b.paidAt)} · {b._count?.items ?? 0} item
                      {(b._count?.items ?? 0) !== 1 ? 's' : ''} · {b.paymentMethod}
                    </p>
                    <p className="text-sm text-zinc-700 mt-0.5 flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-zinc-400" />
                      {b.customer?.name ?? 'Walk-in customer'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-lg tabular-nums">₹{fmt(b.totalAmount)}</p>
                    {Number(b.balanceDue) > 0 && (
                      <p className="text-xs text-amber-700 font-medium mt-0.5 tabular-nums">
                        ₹{fmt(b.balanceDue)} still owed
                      </p>
                    )}
                    {!returnable && (
                      <p className="text-xs text-muted-foreground mt-0.5">Not returnable</p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
