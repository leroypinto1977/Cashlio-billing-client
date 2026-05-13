# Cashlio — Billing Client (App C)

The Electron desktop application installed on cashier workstations. Has no local database — connects to the Main Local server (App B) over the shop's LAN for authentication and data. On first launch, the cashier enters the server's IP address and names the terminal; subsequent launches go straight to login.

## Tech Stack

- **Desktop**: Electron 39
- **Renderer**: React 19 + Vite (electron-vite)
- **Routing**: React Router v7
- **HTTP**: Axios (connects to App B on LAN)
- **UI**: Tailwind CSS + Shadcn UI

## Prerequisites

- Node.js 20+
- App B (main-local) running and reachable on the same LAN

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `VITE_DEFAULT_SERVER_PORT` | Pre-fills the port field on the Network Discovery screen (default: `52001`) |

## Development

```bash
npm run dev
```

Starts the Vite renderer dev server and launches the Electron window. DevTools open automatically as a detached window.

## Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

## First-Launch Flow

1. **Splash** — 3-second loading screen
2. **Network Discovery** — Enter the Main Server IP, give this terminal a name (e.g. "Counter 1"), and confirm the port. The app sends a pairing request to App B — if the license has capacity, the terminal is registered and its name appears in the Manager dashboard
3. **Login** — Cashier logs in with credentials verified against App B
4. **Dashboard** — Cashier workspace (billing features in development)

On subsequent launches the app skips directly to Login (IP is saved in `localStorage`). If already logged in, it goes straight to the Dashboard.

## Screens & Routes

| Route | Screen | Description |
|---|---|---|
| `/` | Auto-redirect | → `/dashboard` if token exists, → `/login` if paired, → `/setup` if fresh |
| `/setup` | Network Discovery | Server URL, terminal name, port |
| `/login` | Cashier Login | Authenticates against App B |
| `/dashboard` | Cashier Dashboard | Main workspace after login |

## Project Structure

```
src/
├── main/
│   └── index.ts              # Electron main process (window, IPC, MAC address, CSP override)
├── preload/
│   └── index.ts              # Context bridge (exposes ipcRenderer.invoke/send/on)
└── renderer/
    └── src/
        ├── App.tsx            # Router setup and auth-aware redirects
        └── components/
            ├── Setup.tsx      # Network Discovery screen
            ├── Login.tsx      # Cashier login screen
            └── Dashboard.tsx  # Cashier dashboard
```
