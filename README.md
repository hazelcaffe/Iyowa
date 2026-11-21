# Iyowa

Iyowa opens a signed Isolated Web App in a normal Chromium tab. Upload a `.swbn`, paste a bundle or update-manifest URL, or try the included signed example. No Chrome IWA flags, enterprise enrollment, extension, or native IWA installation is needed.

**Run it:** Node 24+ and PNPM. Open **http://localhost:4178** in a current Chromium browser.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm build && pnpm start` serves the built version. `PORT` changes the port. Keep the port stable to retain browser storage. The default host binds to `127.0.0.1`; Chromium resolves `*.localhost` itself. The development shell uses Vite. Restart `pnpm dev` after changing the guest bootstrap, worker, or host code.

## Use the SDK without the sample UI

[`sdk/index.ts`](sdk/index.ts) is the browser API. It has no UI dependencies. The host also serves the built ES module at `/sdk.js`. For a replacement UI, edit `ui/` or point `IYOWA_UI_DIR` at a separate frontend build when running `pnpm start`. Serve that UI on the launcher origin so it can use the same-origin library API.

```js
import { IwaRuntime } from "/sdk.js";

const runtime = new IwaRuntime();
const app = await runtime.install(fileInput.files[0]);
const session = runtime.launch(app, document.querySelector("main"));
session.addEventListener("error", (event) => console.error(event.detail));
await session.ready;
```

| API                                                       | Behavior                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install(Blob \| ArrayBuffer)`                            | Verify the signed package, persist it, and return `AppInfo` including the parsed manifest, signing ID, digest, and start path.                             |
| `installURL(url, {channel, expectedId}?)`                 | Import a public HTTPS bundle or select the highest numeric version on an update channel. Relative `src` is resolved against the final manifest URL.        |
| `update(app, channel?)`                                   | Use the app's update manifest and require the same signing identity. Downgrades and conflicting contents at the same version are rejected.                 |
| `list()`, `remove(id)`                                    | Manage the package library. Removal deletes the package; browser-managed site data is separate.                                                            |
| `launch(app, element, path?)`                             | Return a session with `frame`, `ready`, `navigate`, `reload`, `stop`, and `ready`/`error`/`stop` events.                                                   |
| `session.openProtocol(url)`, `deliverLaunch(url, files?)` | Resolve a registered manifest protocol handler or deliver to the app's `launchQueue`. These registrations belong to the runtime, not the operating system. |

For Node consumers, `@iyowa/runtime/bundle` exports `readBundle(bytes)` for offline verification and exchange inspection. `@iyowa/runtime/host` exports `createHost({port, dataDir, uiDir, grants, bindings, managedOrigins})` with `install`, `list`, `origin`, and `close`. Use `port: 0` for an ephemeral test host.

## Where things run

| Component                                       | Responsibility                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host/`                                         | Local Node companion. Reads/verifies bundle uploads, downloads URL imports, persists the original signed bytes in `.iyowa/` (`IYOWA_DATA` overrides), serves exchanges, and provides the optional socket transport. This is a local service, not a static-only deployment.       |
| `runtime/bundle.ts`, `runtime/legacy.ts`        | Web Bundle parser, integrity verification, origin and manifest validation. Supports current integrity blocks and older single-signature `1b` blocks; Ed25519 and P-256 are tested.                                                                                               |
| `runtime/guest.ts`, `runtime/worker.ts`         | Browser bootstrap before the app's scripts. Every signing ID gets its own real `http://<id>.localhost:<port>` origin: relative imports, workers, IndexedDB, and **app-owned service workers** can use their normal URLs and browser storage. App JavaScript runs in the browser. |
| `runtime/controlled-frame.ts`, `runtime/proxy/` | DOM compatibility API and separately originated frame partitions. Managed frames use the **Scramjet v2 core from the browser.js ecosystem** (`2.1.0`), including its fetch handler, client hooks, HTML/JS/CSS rewriters, and WASM. The browser.js frontend is not bundled.       |
| `runtime/sockets.ts`, `runtime/virtual-hub.ts`  | Streams-based Direct Sockets, per-app virtual networking in a SharedWorker, and **wisp-js** clients.                                                                                                                                                                             |
| `ui/main.ts`                                    | Minimal file/URL/example launcher. All install and launch operations go through the SDK.                                                                                                                                                                                         |

An upload is sent to **your local companion**. No external service is required for a packaged, offline app. Signature verification establishes which key signed the package; it does not establish publisher reputation. The host re-verifies stored packages on startup. URL import uses bounded downloads (128 MiB), validates redirects, and pins public DNS results to the TLS connection.

## Direct Sockets

The default network is virtual and app-scoped. `TCPServerSocket` supports listeners and accepted `TCPSocket`s; `TCPSocket` supplies byte streams and BYOB reads. `UDPSocket` supports connected and bound mode, sender metadata, and virtual multicast membership. Apps can communicate between a window and its dedicated workers. Kitchen Sink's default IPv6 listener works with no configuration.

To talk to a real endpoint you own, configure `IYOWA_SOCKET_GRANTS` as a JSON array. Each entry is an **exact signing ID, protocol, IP address, and port**. For example, to reach your own TCP service on port 7000:

```sh
IYOWA_SOCKET_GRANTS='[{"id":"YOUR_BUNDLE_ID","protocol":"tcp","address":"127.0.0.1","port":7000}]' pnpm start
```

Outgoing TCP and connected UDP use Wisp v2 at the app origin. The relay checks both the WebSocket origin and each CONNECT packet before network I/O. Apps must declare `cross-origin-isolated` and `direct-sockets`; real private and loopback endpoints also require `direct-sockets-private`.

**Real listeners:** `IYOWA_SOCKET_BINDINGS` uses the same entry format. It allows `TCPServerSocket` or bound `UDPSocket` to receive traffic from OS clients on `127.0.0.1` or `::1`. Port `0` requests an OS-selected port; fixed ports must be ≥1024. The runtime reports the actual port through `opened`. Bound UDP can reply to observed senders or send to explicitly granted UDP destinations. This is a small separate companion protocol because standard Wisp has no listen/accept operation. Neither setting is needed to run the virtual network.

## Controlled Frames

The `controlled-frame` and `cross-origin-isolated` manifest permissions enable the adapter. Static markup and `document.createElement("controlledframe")` both work.

- **Bundled pages** run in managed frames automatically. The app, frame partition, and virtual site determine a distinct browser origin. `persist:` names are stable; other names are scoped to the app document's lifetime.
- **Ordinary remote URLs** use a credentialless native iframe. The remote site's embedding policy applies.
- **Managed remote sites** must be listed in `IYOWA_FRAME_ORIGINS` (a JSON array of origins). The publisher must allow CORS from the partition origin and expose `X-Iyowa-Embed: allow` on the resources being loaded. This enables Scramjet rewriting and the control bridge. The transport does not use the user's browser credentials. Example response headers for a public integration:

  ```http
  Access-Control-Allow-Origin: *
  Access-Control-Expose-Headers: X-Iyowa-Embed
  X-Iyowa-Embed: allow
  ```

Managed frames support programmatic navigation/history, lifecycle and console events, CSS and script injection (including bundled files), content scripts, zoom, store clearing, audio muting, custom context menus and popup requests. Interceptors can cancel API-initiated navigations, block managed document fetch/XHR, or modify supported request headers. See [tested behavior and limitations](docs/compatibility.md) for the exact boundaries.

## Tests

```sh
pnpm exec playwright install chromium   # once, if needed
pnpm check                             # Biome + strict ESNext TypeScript
pnpm test                              # unit + signed fixture in headless Chromium
pnpm test:public                       # fetch pinned artifacts, then exercise public IWAs
```

`fixtures/bundle.ts` builds a real signed `.swbn` (`dist/example.swbn`). Its deterministic key is **only a public fixture identity**. Public binaries are cached under `.cache/public`, not vendored. Playwright uses temporary package stores and ephemeral ports. See [compatibility results](docs/compatibility.md) and [public artifact URLs and SHA-256 pins](scripts/public.ts).
