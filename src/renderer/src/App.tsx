import React from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Setup from './components/Setup'
import Login from './components/Login'
import Dashboard from './components/Dashboard'

function App(): React.JSX.Element {
  const hasIp = localStorage.getItem('mainServerIp')
  const hasToken = localStorage.getItem('cashierToken')

  return (
    <HashRouter>
      <Routes>
        <Route
          path="/"
          element={
            hasIp && hasToken
              ? <Navigate to="/dashboard" replace />
              : hasIp
              ? <Navigate to="/login" replace />
              : <Setup />
          }
        />
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </HashRouter>
  )
}

export default App
