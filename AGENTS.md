# MAS Secure Messenger

## Cursor Cloud specific instructions

**Codebase overview:** npm workspaces monorepo (TypeScript + React) for an end-to-end encrypted messaging app. See `README.md` for structure and dev commands.

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| API Server | `npm run dev:server` | 4000 | Express + WebSocket; uses `tsx watch`; SQLite store (`data/mas.db` via `better-sqlite3`), no external DB |
| Web Client | `npm run dev:web` | 5173 | Vite + React SPA |

### Key dev notes

- **SMS auth in dev:** The server returns `devCode` in the `POST /auth/request` response body, so no external SMS provider is needed. Use any valid phone number format.
- **No external dependencies:** No databases, Docker, or third-party services are required. The server uses an embedded SQLite file (`data/mas.db`).
- **Typecheck:** `npm run typecheck` passes cleanly across all workspaces.
- **Build:** `npm run build:web` succeeds cleanly.
- **Web client resolves** `API_URL`/`WS_URL` in `apps/web/src/App.tsx` using this priority: (1) `localStorage["mas.apiUrl"]`/`mas.wsUrl` runtime override, (2) `VITE_API_URL`/`VITE_WS_URL` build-time env vars (see `apps/web/.env.example`; copy to `.env.local`), (3) fallback to `<window.location.hostname>:4000`. Copy `.env.example` to `.env.local` and set the API server's LAN IP when running the web client on a machine different from the server.
- **Server listens on `0.0.0.0:4000`** by default (override with `HOST` / `PORT` env vars) so other machines on the LAN can reach it. CORS automatically allows requests from private LAN ranges (10/8, 172.16/12, 192.168/16, 169.254/16, loopback) — override completely via `CORS_ORIGINS` if needed.
- **Vite dev server** is configured with `host: true` in `apps/web/vite.config.ts`, so it binds on all interfaces and is reachable from other machines on `http://<lan-ip>:5173`.
- **WebSocket + StrictMode bug:** `React.StrictMode` in `apps/web/src/main.tsx` causes the WebSocket `useEffect` (in `App.tsx`) to double-mount, creating a race: the stale socket's `close` event fires `clients.delete(userId)` on the server after the new socket has already registered, making the user appear offline. This blocks incoming call delivery and real-time presence in dev mode.
- **Call testing in VM:** `startCall`/`acceptCall` call `navigator.mediaDevices.getUserMedia()` without try/catch. In headless/VM environments without audio/video hardware, calls fail silently. Server-side call signaling (offer/answer/ICE/end relay) can be tested programmatically via WebSocket clients.
