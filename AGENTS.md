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
- **Client API URL:** Web and desktop default to `VITE_API_URL` or `http://localhost:4000`, and users can override it in app settings via `mas.apiUrl`. WebSocket URLs are derived from the API URL unless `VITE_WS_URL` is set.
- **Public server setup:** For port-forwarded deployments, keep the Node server on `HOST=127.0.0.1` and expose only Caddy on `80/443`. See `docs/public-server.md`.
- **Call testing in VM:** Calls use `navigator.mediaDevices.getUserMedia()` and configurable ICE servers from `GET /config/ice`. In headless/VM environments without audio/video hardware, media calls can still fail; server-side call signaling can be tested programmatically via WebSocket clients.
