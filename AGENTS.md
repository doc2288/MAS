# MAS Secure Messenger

## Cursor Cloud specific instructions

**Codebase overview:** npm workspaces monorepo (TypeScript + React) for an end-to-end encrypted messaging app. See `README.md` for structure and dev commands.

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| API Server | `npm run dev:server` | 4000 | Express + WebSocket; uses `tsx watch`; JSON file store (`data/db.json`), no external DB |
| Web Client | `npm run dev:web` | 5173 | Vite + React SPA |

### Key dev notes

- **SMS auth in dev:** The server returns `devCode` in the `POST /auth/request` response body, so no external SMS provider is needed. Use any valid phone number format.
- **No external dependencies:** No databases, Docker, or third-party services are required. The server stores data in a flat JSON file.
- **Typecheck:** `npm run typecheck` has pre-existing errors in `apps/server` due to `NodeNext` moduleResolution requiring `.js` extensions in imports and a missing `@types/cors` dev dependency. The server still runs fine via `tsx`.
- **Build:** `npm run build:web` succeeds cleanly.
- **Web client hardcodes** `API_URL = "http://localhost:4000"` and `WS_URL = "ws://localhost:4000"` in `apps/web/src/App.tsx`. Start the server before the web client.
- **WebSocket + StrictMode bug:** `React.StrictMode` in `apps/web/src/main.tsx` causes the WebSocket `useEffect` (in `App.tsx`) to double-mount, creating a race: the stale socket's `close` event fires `clients.delete(userId)` on the server after the new socket has already registered, making the user appear offline. This blocks incoming call delivery and real-time presence in dev mode.
- **Call testing in VM:** `startCall`/`acceptCall` call `navigator.mediaDevices.getUserMedia()` without try/catch. In headless/VM environments without audio/video hardware, calls fail silently. Server-side call signaling (offer/answer/ICE/end relay) can be tested programmatically via WebSocket clients.
