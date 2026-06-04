# Public MAS Server With Port Forwarding

This setup keeps the web/desktop messenger UI local on each device. Only the API/WebSocket server is reachable from the internet through your domain.

## Network Shape

- MAS server: `127.0.0.1:4000` on this PC.
- Caddy on the same PC: public `80/443`, proxying to `127.0.0.1:4000`.
- Router: forward TCP `80` and `443` to this PC.
- Clients: run web/desktop locally and set `Server URL` to `https://mas.example.com`.
- Android: set the same `Server URL` in the mobile app before phone login and before approving QR login.

If your provider uses CGNAT, inbound port forwarding will not work. Use a tunnel or VPN instead.

## Server Environment

Use values like these for the server process:

```powershell
$env:NODE_ENV="production"
$env:HOST="127.0.0.1"
$env:PORT="4000"
$env:TRUST_PROXY="true"
$env:JWT_SECRET="replace-with-a-long-random-secret"
$env:DEV_AUTH_CODES="true"
$env:CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,tauri://localhost,http://tauri.localhost"
$env:ICE_SERVERS_JSON='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"mas","credential":"replace-me"}]'
```

`DEV_AUTH_CODES=true` is for the current test server without a real SMS provider. It makes `/auth/request` return the one-time code as `devCode` so Android, web, and desktop can sign in. Turn it off only after a real SMS provider is implemented and configured.

For reliable calls and screen sharing between different networks, configure a real TURN server in `ICE_SERVERS_JSON`.

## Caddy

Point your DDNS/domain record to your home public IP, then use this Caddyfile:

```caddyfile
mas.example.com {
  reverse_proxy 127.0.0.1:4000
}
```

Caddy should be the only process exposed by the router. Do not forward port `4000` to the internet.

## Checks

- Local backend: `http://127.0.0.1:4000/health`
- Public backend: `https://mas.example.com/health`
- WebSocket URL derived by clients: `wss://mas.example.com`
- Security check: `http://mas.example.com` redirects to HTTPS, and public `mas.example.com:4000` is not reachable.

## Client URL

Use the same value everywhere:

```text
https://mas.example.com
```

Do not add `/health` or `:4000`. In Android, enter it in `Server URL` and press `Save server URL`; the QR approve flow uses the saved URL.
