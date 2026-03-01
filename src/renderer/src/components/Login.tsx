import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { LogIn, Lock, AlertCircle, Settings } from 'lucide-react'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const ip = localStorage.getItem('mainServerIp')
    const port = localStorage.getItem('mainServerPort') || '5000'
    if (!ip) {
      navigate('/') // Redirect to setup if no IP is saved
    } else {
      setServerAddress(`http://${ip}:${port}`)
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
        // Save token or session info here if needed
        localStorage.setItem('cashierToken', response.data.token || 'mock_token')
        // In this phase, there is no real dashboard yet. Just a placeholder alert.
        alert('Login Successful! Welcome to the Cashier Dashboard.')
        setStatus('idle')
      }
    } catch (error: any) {
      console.error('Login failed:', error)
      setStatus('error')
      setErrorMessage(
        error.response?.data?.error || 
        'Invalid credentials or server unreachable.'
      )
    }
  }

  const handleResetSetup = () => {
    localStorage.removeItem('mainServerIp')
    localStorage.removeItem('mainServerPort')
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 font-sans text-slate-100">
      
      {/* Absolute positioned reset button */}
      <button 
        onClick={handleResetSetup}
        className="absolute top-6 right-6 text-slate-500 hover:text-slate-300 flex items-center gap-2 text-sm font-medium transition-colors bg-slate-800/50 hover:bg-slate-800 py-2 px-3 rounded-xl border border-slate-700 hover:border-slate-600"
        title="reconfigure server connection"
      >
        <Settings size={16} />
        Network Config
      </button>

      <div className="max-w-md w-full">
        {/* Header section outside the card for a cleaner look */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-[1.25rem] flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-500/50">
            <Lock size={32} className="text-white" />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-white mb-3 font-display">Cashlio</h1>
          <p className="text-slate-400 text-lg">Cashier Terminal Login</p>
        </div>

        {/* Login Card */}
        <div className="bg-slate-800/80 backdrop-blur-xl rounded-3xl shadow-2xl border border-slate-700/50 p-8">
          <form onSubmit={handleLogin} className="space-y-6">
            
            <div className="space-y-4">
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-slate-300 mb-2 ml-1">Cashier Username</label>
                <input
                  id="username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-slate-900/60 border border-slate-600 rounded-2xl px-5 py-4 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all shadow-inner"
                  required
                />
              </div>
              
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-2 ml-1">Password</label>
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-900/60 border border-slate-600 rounded-2xl px-5 py-4 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all shadow-inner"
                  required
                />
              </div>
            </div>

            {status === 'error' && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex gap-3 text-red-400 text-sm animate-in fade-in slide-in-from-top-2 duration-300">
                <AlertCircle size={18} className="shrink-0 mt-0.5" />
                <p>{errorMessage}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className={`w-full font-bold rounded-2xl py-4 px-6 flex items-center justify-center gap-2 transition-all duration-200 mt-8 ${
                status === 'loading'
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white shadow-lg shadow-emerald-500/25 ring-1 ring-emerald-500/50 translate-y-0 hover:-translate-y-0.5'
              }`}
            >
              {status === 'loading' ? (
                <>
                  <Settings className="animate-spin" size={20} />
                  Authenticating...
                </>
              ) : (
                <>
                  <LogIn size={20} className="mr-1" />
                  Sign In to Terminal
                </>
              )}
            </button>
          </form>
        </div>
        
        {/* Footer info */}
        <div className="text-center mt-8 text-sm text-slate-500">
          <p>Connected to: <span className="font-mono text-slate-400 bg-slate-800/50 px-2 py-1 rounded">{serverAddress.replace('http://', '')}</span></p>
        </div>
        
      </div>
    </div>
  )
}
