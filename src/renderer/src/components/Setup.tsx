import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Server, Settings, CheckCircle, AlertTriangle } from 'lucide-react'

export default function Setup() {
  const [ipAddress, setIpAddress] = useState('')
  const [port, setPort] = useState('5000')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const navigate = useNavigate()

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ipAddress) return

    setStatus('loading')
    setErrorMessage('')

    try {
      const macAddress = '00:1A:2B:3C:4D:5E' // Mock MAC address
      const serverUrl = `http://${ipAddress}:${port}`

      const response = await axios.post(`${serverUrl}/api/v1/system/pair-client`, {
        mac_address: macAddress,
        friendly_name: 'Billing Terminal'
      })

      if (response.status === 200) {
        setStatus('success')
        localStorage.setItem('mainServerIp', ipAddress)
        localStorage.setItem('mainServerPort', port)

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

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 font-sans text-slate-100">
      <div className="max-w-md w-full bg-slate-800 rounded-3xl shadow-2xl overflow-hidden border border-slate-700/50">
        <div className="p-8 text-center bg-gradient-to-b from-slate-800 to-slate-800/80">
          <div className="w-16 h-16 bg-blue-500/20 text-blue-400 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-inner ring-1 ring-blue-500/30">
            <Server size={32} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2 font-display">
            Network Setup
          </h1>
          <p className="text-slate-400 text-sm">
            Configure this terminal to connect to your Main Local Server.
          </p>
        </div>

        <div className="px-8 pb-8">
          <form onSubmit={handleConnect} className="space-y-6">
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="ipAddress"
                  className="block text-sm font-medium text-slate-300 mb-2"
                >
                  Main Server IP Address
                </label>
                <input
                  id="ipAddress"
                  type="text"
                  placeholder="e.g. 192.168.1.100"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  className="w-full bg-slate-900/50 border border-slate-600 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  required
                />
              </div>

              <div>
                <label htmlFor="port" className="block text-sm font-medium text-slate-300 mb-2">
                  Port Configuration
                </label>
                <input
                  id="port"
                  type="text"
                  placeholder="5000"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-full bg-slate-900/50 border border-slate-600 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Leave as 5000 unless changed on the main server.
                </p>
              </div>
            </div>

            {status === 'error' && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex gap-3 text-red-400 text-sm items-start">
                <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                <p>{errorMessage}</p>
              </div>
            )}

            {status === 'success' && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex gap-3 text-emerald-400 text-sm items-center justify-center font-medium">
                <CheckCircle size={18} />
                <p>Connection established! Redirecting...</p>
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'loading' || status === 'success'}
              className={`w-full font-semibold rounded-xl py-3.5 px-4 flex items-center justify-center gap-2 transition-all duration-200 ${
                status === 'loading' || status === 'success'
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 hover:shadow-blue-500/30 ring-1 ring-blue-500/50'
              }`}
            >
              {status === 'loading' ? (
                <>
                  <Settings className="animate-spin" size={20} />
                  Connecting...
                </>
              ) : status === 'success' ? (
                'Connected'
              ) : (
                'Pair with Server'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
