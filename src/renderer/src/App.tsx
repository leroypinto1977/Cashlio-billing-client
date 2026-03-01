import React from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Setup from './components/Setup'
import Login from './components/Login'

function App(): React.JSX.Element {
  // Check if we already have the main server IP stored
  const hasIp = localStorage.getItem('mainServerIp')

  return (
    <HashRouter>
      <Routes>
        <Route 
          path="/" 
          element={hasIp ? <Navigate to="/login" replace /> : <Setup />} 
        />
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </HashRouter>
  )
}

export default App
