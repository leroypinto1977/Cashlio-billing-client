import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShoppingCart, LogOut, Monitor, Wifi, WifiOff, Clock, AlertCircle } from 'lucide-react'
import { Button } from './ui/button'
import BillingScreen from './BillingScreen'

export default function Dashboard() {
  const navigate = useNavigate()
  const [cashierUsername, setCashierUsername] = useState('')
  const [terminalName, setTerminalName] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [pendingBills, setPendingBills] = useState(0)

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

      {/* Main content — billing screen */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <BillingScreen onPendingCountChange={setPendingBills} />
      </main>
    </div>
  )
}
