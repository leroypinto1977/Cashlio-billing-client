/// <reference types="vite/client" />

interface Window {
  api: {
    getMacAddress: () => Promise<string>
  }
}
