# How Iyowa works

An Isolated Web App is a [Signed Web Bundle](https://github.com/WICG/webpackage) (`.swbn`) that Chrome normally installs and serves from `isolated-app://<bundle-id>/`. Those apps then get APIs ordinary sites don't, such as Direct Sockets and `<controlledframe>`. Iyowa recreates that environment from parts every Chromium browser already has: real origins on `localhost`, iframes, service workers, and a small local Node server.

```
┌─ Chromium tab ───────────────────────────────────────────────────────────────┐
│ Launcher  http://localhost:4178              (packages/ui, uses the SDK)     │
│ ┌─ App frame  http://<bundle-id>.localhost:4178 ───────────────────────────┐ │
│ │ guest.js: Direct Sockets · <controlledframe> · capture · display         │ │
│ │                                                                          │ │
│ │ ┌─ Controlled frame  http://p-<hash>.localhost:4178 ───────────────────┐ │ │
│ │ │ Scramjet client <-> service worker <-> libcurl.js (TLS in the tab)   │ │ │
│ │ └──────────────────────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │  HTTP · Wisp · bind
┌──────────────────────────────────────┴───────────────────────────────────────┐
│ Iyowa host (Node, 127.0.0.1)        packages/sdk/src/host                    │
│ verified bundle store · per-app permissions · Wisp relay · OS listeners      │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Bundles and origins

[`src/bundle`](../packages/sdk/src/bundle) parses the bundle and verifies its integrity block. It supports current and legacy `1b` blocks, with Ed25519 and ECDSA P-256 signatures. The bundle ID must be derived from the key that actually signed the payload. Iyowa also checks the manifest and the start URL. The host stores the original signed bytes and verifies them again at startup.

Each app is served from its own real origin, `http://<bundle-id>.localhost:<port>`. Relative URLs, ES modules, workers, IndexedDB, and **the app's own service worker** all behave normally, and storage is isolated per app by the browser. The host sends the IWA's baseline CSP, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and a Permissions Policy derived from the manifest, so `crossOriginIsolated` is true and undeclared features stay off. Same-ID `isolated-app://` URLs in HTML, CSS, JavaScript, and `fetch()` are translated to the real origin.

## The in-app runtime

Before any app script runs, the host injects [`guest.js`](../packages/sdk/src/runtime/guest.ts) into every app document and a worker variant into the app's workers. It installs:

| Module                                                                   | Provides                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`sockets.ts`](../packages/sdk/src/runtime/sockets.ts)                   | `TCPSocket`, `TCPServerSocket`, `UDPSocket`                                                   |
| [`controlled-frame.ts`](../packages/sdk/src/runtime/controlled-frame.ts) | `<controlledframe>` and its API                                                               |
| [`capture.ts`](../packages/sdk/src/runtime/capture.ts)                   | `navigator.mediaDevices.getAllScreensMedia()`                                                 |
| [`display.ts`](../packages/sdk/src/runtime/display.ts)                   | `display-mode` media queries, including `unframed` once window management is granted          |
| [`popups.ts`](../packages/sdk/src/runtime/popups.ts)                     | App `window.open()` popups as in-tab windows with a real `opener`                             |
| [`bridge.ts`](../packages/sdk/src/runtime/bridge.ts)                     | Messages to the launcher: readiness, title, console, socket activity, and permission requests |
| `guest.ts`                                                               | `launchQueue`, plus `isolated-app://` translation for `fetch()`                               |

## Direct Sockets

Every socket picks a route when it opens:

- **in-app:** a SharedWorker hub ([`virtual-hub.ts`](../packages/sdk/src/runtime/virtual-hub.ts)) gives each app a private loopback network shared by its windows and dedicated workers. It's used for loopback traffic when the app doesn't have local network access, so local servers inside an app keep working.
- **network:** outgoing TCP and UDP use [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) v2 over `ws://<app>/.iyowa/wisp/`. The relay ([`relay.ts`](../packages/sdk/src/host/relay.ts)) checks each destination **after DNS resolution**, against the address it is about to connect to. Public addresses are allowed for apps that declare `direct-sockets`. Private and loopback addresses also need `direct-sockets-private` and the user's local network grant. After a successful TCP handshake, the relay sends an early CONTINUE packet so `opened` resolves only once the remote side has accepted the connection.
- **system:** with local network access, `TCPServerSocket` and bound `UDPSocket` open real OS sockets through a small companion protocol on `/.iyowa/bind/` ([`bindings.ts`](../packages/sdk/src/host/bindings.ts)), because Wisp has no listen or accept operation.

When a connection needs local access that hasn't been decided yet, the socket asks the launcher through the SDK's `permissionrequest` event, then retries. That also covers a public-looking hostname that resolves to a private address. The answer is stored per app in `state.json` in the host's data directory.

## Controlled frames

A `<controlledframe>` holds an iframe pointing at a **partition origin**, `http://p-<sha256(app, partition)>.localhost:<port>`. Each app and partition pair gets its own browser storage. The partition registers a [Scramjet](https://github.com/MercuryWorkshop/scramjet) v2 service worker ([`frame/sw.ts`](../packages/sdk/src/frame/sw.ts)) and serves pages at `/view/<encoded URL>`:

1. The service worker rewrites every document, script, stylesheet, and worker for the proxied site, keeps the partition's cookie jar in Cache Storage, and fetches through [libcurl.js](https://github.com/ading2210/libcurl.js) over the partition's own Wisp relay. TLS terminates inside the tab. The relay only sees encrypted TCP bytes, and it refuses private addresses unless the app has local network access.
2. A client script ([`frame/client.ts`](../packages/sdk/src/frame/client.ts)) runs first in every proxied document. It captures the platform functions it needs before Scramjet hooks the page, then connects the page to the embedding app with `postMessage`. That carries `executeScript` (evaluated through Scramjet's rewriter, so `location` describes the proxied site), `insertCSS`, lifecycle and console events, `newwindow`, context menus, storage clearing, and muting.
3. Page-initiated WebSockets and `fetch()` calls go through an unhooked dedicated worker ([`frame/net-worker.ts`](../packages/sdk/src/frame/net-worker.ts)) that also uses libcurl.js.
4. Request interceptors run in the app. For each request, the service worker asks the frame's top document, which forwards the request to the app over a `MessagePort`. The app can block it or replace its headers before it leaves the browser.

Bundled pages loaded in a frame use the stand-in origin `https://bundle.invalid`, served from `/.iyowa/resource/*`, because Scramjet proxies only `http(s)`. The element's `src` and events still report `isolated-app://` URLs.

## The SDK and launcher

[`src/client`](../packages/sdk/src/client/index.ts) is the browser SDK. `IwaRuntime` manages the library through the host's same-origin API, and `IwaSession` owns an app frame, routes guest messages by origin, and turns them into events. The launcher in [`packages/ui`](../packages/ui) is a React app built only on that SDK. [`createHost()`](../packages/sdk/src/host/index.ts) serves any UI from a static directory or a connect-style handler, such as Vite middleware during development.

All runtime pieces are compiled by [`scripts/build.ts`](../packages/sdk/scripts/build.ts) with esbuild into `packages/sdk/dist`. The host serves them from the reserved `/.iyowa/` path on each origin.
