import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { LogIn, Lock, AlertCircle, Settings } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Button } from './ui/button'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const ip = localStorage.getItem('mainServerIp')
    const port = localStorage.getItem('mainServerPort') || (import.meta.env.VITE_DEFAULT_SERVER_PORT as string) || '52001'
    if (!ip) {
      navigate('/') // Redirect to setup if no IP is saved
    } else {
      setServerAddress(`https://${ip}:${port}`)
    }
  }, [navigate])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password || !serverAddress) return

    setStatus('loading')
    setErrorMessage('')

    try {
      const response = await axios.post(`${serverAddress}/api/v1/auth/login`, {
        username,
        password
      })

      if (response.status === 200) {
        localStorage.setItem('cashierToken', response.data.token)
        localStorage.setItem('cashierUsername', username)
        navigate('/dashboard')
      }
    } catch (error: any) {
      console.error('Login failed:', error)
      setStatus('error')
      setErrorMessage(error.response?.data?.error || 'Invalid credentials or server unreachable.')
    }
  }

  const handleResetSetup = () => {
    localStorage.removeItem('mainServerIp')
    localStorage.removeItem('mainServerPort')
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4 font-sans text-zinc-900 relative">
      {/* Absolute positioned reset button */}
      <Button
        onClick={handleResetSetup}
        variant="outline"
        className="absolute top-6 right-6 border-zinc-200 bg-white hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 shadow-sm rounded-md h-9 px-3 text-sm font-medium"
        title="Reconfigure server connection"
      >
        <Settings size={14} className="mr-2" />
        Network Config
      </Button>

      <Card className="w-full max-w-md border-zinc-200 bg-white shadow-sm rounded-lg">
        <CardHeader className="text-center space-y-4 pb-8">
          <div className="w-16 h-16 bg-zinc-100 text-zinc-900 rounded-lg flex items-center justify-center mx-auto border border-zinc-200">
            <Lock size={32} strokeWidth={1.5} />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-3xl font-extrabold tracking-tight text-zinc-900">
              Cashlio
            </CardTitle>
            <CardDescription className="text-zinc-500 text-lg">
              Cashier Terminal Login
            </CardDescription>
          </div>
        </CardHeader>

        <form onSubmit={handleLogin}>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-sm font-medium text-zinc-900 ml-1">
                  Username
                </Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-white border-zinc-200 text-zinc-900 focus-visible:ring-zinc-900 focus-visible:ring-2 h-10 rounded-md"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium text-zinc-900 ml-1">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-white border-zinc-200 text-zinc-900 focus-visible:ring-zinc-900 focus-visible:ring-2 h-10 rounded-md"
                  required
                />
              </div>
            </div>

            {status === 'error' && (
              <Alert
                variant="destructive"
                className="bg-red-50 border-red-200 text-red-900 rounded-md"
              >
                <AlertCircle className="h-4 w-4 stroke-red-600" />
                <AlertTitle className="text-red-800 font-semibold">
                  Authentication Failed
                </AlertTitle>
                <AlertDescription className="text-red-700">{errorMessage}</AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter className="flex-col space-y-6">
            <Button
              type="submit"
              disabled={status === 'loading'}
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white shadow-none border-0 h-10 rounded-md text-sm font-medium"
            >
              {status === 'loading' ? (
                <>
                  <Settings className="animate-spin mr-2 h-4 w-4" />
                  Authenticating...
                </>
              ) : (
                <>
                  <LogIn className="mr-2 h-4 w-4" />
                  Sign In to Terminal
                </>
              )}
            </Button>

            <div className="text-center text-sm text-zinc-500">
              <p>
                Connected to:{' '}
                <span className="font-mono text-zinc-700 bg-zinc-100 px-2 py-1 rounded border border-zinc-200">
                  {serverAddress.replace('http://', '')}
                </span>
              </p>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
