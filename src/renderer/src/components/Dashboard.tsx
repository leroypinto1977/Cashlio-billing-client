import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShoppingCart, LogOut, Monitor, Wifi, WifiOff, Clock, AlertCircle, RotateCcw, Printer } from 'lucide-react'
import { Button } from './ui/button'
import BillingScreen from './BillingScreen'
import ReturnsScreen from './ReturnsScreen'
import { ReceiptPrinterSettings } from './ReceiptPrinterSettings'

type Tab = 'billing' | 'returns' | 'printer'

export default function Dashboard() {
  const navigate = useNavigate()
  const [cashierUsername, setCashierUsername] = useState('')
  const [terminalName, setTerminalName] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [pendingBills, setPendingBills] = useState(0)
  const [tab, setTab] = useState<Tab>('billing')

  useEffect(() => {
    const token = localStorage.getItem('cashierToken')
    if (!token) {
      navigate('/login')
      return
    }
    setCashierUsername(localStorage.getItem('cashierUsername') || 'Cashier')
    setTerminalName(localStorage.getItem('terminalName') || 'Terminal')

    const ip = localStorage.getItem('mainServerIp') || ''
    const port = localStorage.getItem('mainServerPort') || '52001'
    setServerAddress(`${ip}:${port}`)
  }, [navigate])

  useEffect(() => {
    const tick = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(tick)
  }, [])

  const handleSignOut = () => {
    localStorage.removeItem('cashierToken')
    localStorage.removeItem('cashierUsername')
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-zinc-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 flex items-center justify-center">
            <ShoppingCart className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-lg">Cashlio</span>
          <span className="text-zinc-300 mx-1">|</span>
          <div className="flex items-center gap-1.5 text-sm text-zinc-500">
            <Monitor className="w-3.5 h-3.5" />
            <span>{terminalName}</span>
          </div>

          {/* Billing / Returns switch — big enough to hit on a touch till. */}
          <div className="flex items-center gap-1 ml-3 p-1 rounded-xl bg-zinc-100 border border-zinc-200">
            <button
              type="button"
              onClick={() => setTab('billing')}
              className={`flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-semibold transition-colors ${
                tab === 'billing'
                  ? 'bg-white text-zinc-900 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <ShoppingCart className="w-4 h-4" /> Billing
            </button>
            <button
              type="button"
              onClick={() => setTab('returns')}
              className={`flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-semibold transition-colors ${
                tab === 'returns'
                  ? 'bg-white text-zinc-900 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <RotateCcw className="w-4 h-4" /> Returns
            </button>
            <button
              type="button"
              onClick={() => setTab('printer')}
              className={`flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-semibold transition-colors ${
                tab === 'printer'
                  ? 'bg-white text-zinc-900 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <Printer className="w-4 h-4" /> Printer
            </button>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            {pendingBills > 0
              ? <WifiOff className="w-3.5 h-3.5 text-amber-500" />
              : <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            }
            <span className="font-mono">{serverAddress}</span>
          </div>
          {pendingBills > 0 && (
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full">
              <AlertCircle className="w-3.5 h-3.5" />
              {pendingBills} bill{pendingBills !== 1 ? 's' : ''} pending sync
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Clock className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">{currentTime.toLocaleTimeString()}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-zinc-900 flex items-center justify-center text-white text-xs font-bold uppercase">
              {cashierUsername.charAt(0)}
            </div>
            <span className="text-sm font-medium">{cashierUsername}</span>
          </div>
          <Button
            variant="outline"
            onClick={handleSignOut}
            className="h-8 px-3 text-xs border-zinc-200 text-zinc-600 hover:text-red-600 hover:border-red-200 hover:bg-red-50"
          >
            <LogOut className="w-3.5 h-3.5 mr-1.5" />
            Sign Out
          </Button>
        </div>
      </header>

      {/* Main content.

          BillingScreen stays mounted whichever tab is showing and is hidden
          with CSS instead. Its cart, attached customer, discounts and typed
          tender amounts all live in component state, so unmounting it to show
          Returns would silently throw away a half-built sale — a cashier
          nipping over to process a return mid-basket would come back to an
          empty till. Keeping it mounted also keeps its offline sync worker and
          `onPendingCountChange` wiring alive, so the pending-bill badge in the
          header stays accurate while the cashier is on the Returns tab.

          ReturnsScreen is mounted on demand: it holds nothing worth preserving
          between visits, and a fresh mount is exactly the "start again" state
          the next return wants. */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className={`flex-1 flex flex-col min-h-0 ${tab === 'billing' ? '' : 'hidden'}`}>
          <BillingScreen onPendingCountChange={setPendingBills} />
        </div>
        {tab === 'returns' && <ReturnsScreen />}
        {tab === 'printer' && (
          <div className="max-w-xl mx-auto w-full py-8 px-6">
            <ReceiptPrinterSettings />
          </div>
        )}
      </main>
    </div>
  )
}
