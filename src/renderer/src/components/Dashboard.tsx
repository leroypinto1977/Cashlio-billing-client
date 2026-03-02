import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShoppingCart, LogOut, Monitor, Wifi, Clock } from 'lucide-react'
import { Button } from './ui/button'

export default function Dashboard() {
  const navigate = useNavigate()
  const [cashierUsername, setCashierUsername] = useState('')
  const [terminalName, setTerminalName] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())

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
            <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            <span className="font-mono">{serverAddress}</span>
          </div>
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

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
        <div className="w-24 h-24 rounded-2xl bg-white border border-zinc-200 shadow-sm flex items-center justify-center">
          <ShoppingCart className="w-12 h-12 text-zinc-300" strokeWidth={1.5} />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold text-zinc-900">Ready to Bill</h1>
          <p className="text-zinc-500 mt-2 text-sm">
            Cashier dashboard coming soon. Connected to{' '}
            <span className="font-mono text-zinc-700">{serverAddress}</span>.
          </p>
        </div>

        <div className="flex gap-3 mt-2">
          <Button className="bg-zinc-900 hover:bg-zinc-800 text-white px-8 h-11 rounded-lg font-medium">
            New Bill
          </Button>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-4 w-full max-w-lg">
          <div className="bg-white rounded-xl border border-zinc-200 p-4 text-center">
            <p className="text-2xl font-bold text-zinc-900">0</p>
            <p className="text-xs text-zinc-500 mt-1">Bills Today</p>
          </div>
          <div className="bg-white rounded-xl border border-zinc-200 p-4 text-center">
            <p className="text-2xl font-bold text-zinc-900">₹0</p>
            <p className="text-xs text-zinc-500 mt-1">Sales Today</p>
          </div>
          <div className="bg-white rounded-xl border border-zinc-200 p-4 text-center">
            <div className="flex items-center justify-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
              <p className="text-sm font-semibold text-emerald-700">Online</p>
            </div>
            <p className="text-xs text-zinc-500 mt-1">Server Status</p>
          </div>
        </div>
      </main>
    </div>
  )
}
