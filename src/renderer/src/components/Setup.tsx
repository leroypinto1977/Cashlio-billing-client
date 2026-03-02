import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Server, Settings, CheckCircle, AlertTriangle, Monitor } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Button } from './ui/button'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export default function Setup() {
  const [step, setStep] = useState(0) // 0: Splash, 1: Setup
  const [ipAddress, setIpAddress] = useState('')
  const [port, setPort] = useState(
    (import.meta.env.VITE_DEFAULT_SERVER_PORT as string) || '52001'
  )
  const [terminalName, setTerminalName] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const navigate = useNavigate()

  // Splash Screen Timer
  React.useEffect(() => {
    if (step === 0) {
      const timer = setTimeout(() => {
        setStep(1)
      }, 3000)
      return () => clearTimeout(timer)
    }
  }, [step])

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ipAddress || !terminalName) return

    setStatus('loading')
    setErrorMessage('')

    try {
      const macAddress: string = await window.electron.ipcRenderer.invoke('get-mac-address')
      const serverUrl = `http://${ipAddress}:${port}`

      const response = await axios.post(`${serverUrl}/api/v1/system/pair-client`, {
        macAddress,
        friendlyName: terminalName
      })

      if (response.status === 200) {
        setStatus('success')
        localStorage.setItem('mainServerIp', ipAddress)
        localStorage.setItem('mainServerPort', port)
        localStorage.setItem('terminalName', terminalName)

        setTimeout(() => {
          navigate('/login')
        }, 1500)
      }
    } catch (error: any) {
      console.error('Connection failed:', error)
      setStatus('error')
      setErrorMessage(
        error.response?.data?.error ||
          'Could not connect to the Main Server. Please check the IP address and ensure the server is running.'
      )
    }
  }

  // Render Step 0: Splash Screen
  if (step === 0) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6 font-sans drag-region">
        <div className="flex items-center gap-3 animate-pulse">
          <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center shadow-lg">
            <Server className="w-8 h-8 text-black" />
          </div>
          <span className="text-4xl font-bold tracking-tight">Cashlio</span>
        </div>
        <p className="mt-4 text-zinc-400 font-medium">Initializing Cashier Terminal...</p>
      </div>
    )
  }

  // Render Step 1: Network Discovery
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center p-4 font-sans text-zinc-900 drag-region">
      <Card className="w-full max-w-md border-zinc-200 bg-white shadow-sm rounded-lg no-drag-region">
        <CardHeader className="text-center space-y-4 pb-8">
          <div className="w-16 h-16 bg-zinc-100 text-zinc-900 rounded-lg flex items-center justify-center mx-auto border border-zinc-200">
            <Server size={32} strokeWidth={1.5} />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-3xl font-bold tracking-tight text-zinc-900">
              Network Discovery
            </CardTitle>
            <CardDescription className="text-zinc-500">
              Configure this terminal to connect to your Main Local Server.
            </CardDescription>
          </div>
        </CardHeader>

        <form onSubmit={handleConnect}>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ipAddress" className="text-sm font-medium text-zinc-900 ml-1">
                  Server URL / IP Address
                </Label>
                <Input
                  id="ipAddress"
                  type="text"
                  placeholder="e.g. 192.168.1.100"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  className="bg-white border-zinc-200 text-zinc-900 focus-visible:ring-zinc-900 focus-visible:ring-2 rounded-md h-10"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="terminalName" className="text-sm font-medium text-zinc-900 ml-1">
                  Terminal Name
                </Label>
                <div className="relative">
                  <Monitor className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
                  <Input
                    id="terminalName"
                    type="text"
                    placeholder="e.g. Counter 1, Front Desk"
                    value={terminalName}
                    onChange={(e) => setTerminalName(e.target.value)}
                    className="bg-white border-zinc-200 text-zinc-900 focus-visible:ring-zinc-900 focus-visible:ring-2 rounded-md h-10 pl-9"
                    required
                  />
                </div>
                <p className="text-xs text-zinc-500 mt-1 ml-1">
                  This name will be shown in the Manager app's device list.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="port" className="text-sm font-medium text-zinc-900 ml-1">
                  Port
                </Label>
                <Input
                  id="port"
                  type="text"
                  placeholder="52001"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="bg-white border-zinc-200 text-zinc-900 focus-visible:ring-zinc-900 focus-visible:ring-2 rounded-md h-10"
                />
                <p className="text-xs text-zinc-500 mt-1 ml-1">
                  Leave as 52001 unless specified by network admin.
                </p>
              </div>
            </div>

            {status === 'error' && (
              <Alert
                variant="destructive"
                className="bg-red-50 border-red-200 text-red-900 rounded-md"
              >
                <AlertTriangle className="h-4 w-4 stroke-red-600" />
                <AlertTitle className="text-red-800 font-semibold">Connection Failed</AlertTitle>
                <AlertDescription className="text-red-700">{errorMessage}</AlertDescription>
              </Alert>
            )}

            {status === 'success' && (
              <Alert className="bg-emerald-50 border-emerald-200 text-emerald-900 rounded-md">
                <CheckCircle className="h-4 w-4 stroke-emerald-600" />
                <AlertTitle className="text-emerald-800 font-semibold">Connected</AlertTitle>
                <AlertDescription className="text-emerald-700">
                  Pairing successful! Redirecting to login...
                </AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter>
            <Button
              type="submit"
              disabled={status === 'loading' || status === 'success'}
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white rounded-md h-10 border-0 shadow-none font-medium text-sm"
            >
              {status === 'loading' ? (
                <>
                  <Settings className="animate-spin mr-2 h-4 w-4" />
                  Connecting...
                </>
              ) : status === 'success' ? (
                'Paired Successfully'
              ) : (
                'Pair with Server'
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
