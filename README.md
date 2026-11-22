# Iyowa

Iyowa runs signed [Isolated Web Apps](https://github.com/WICG/isolated-web-apps) in an ordinary Chromium tab. You can drop in a `.swbn`, paste a bundle or `update.json` URL, or install a built-in example. It needs no Chrome flags, enterprise policy, extension, or native IWA install. It emulates Direct Sockets, Controlled Frame, `getAllScreensMedia`, unframed windows, launch handling, and protocol handlers well enough for upstream apps such as the ChromeOS Kitchen Sink to run unmodified.

```sh
pnpm install
pnpm dev            # http://localhost:4178, with UI hot reload
```

`pnpm build && pnpm start` serves the production build. `PORT` changes the port; keep it stable, because browser storage belongs to the origin. `IYOWA_DATA` changes the library directory, which defaults to `./.iyowa`. The server listens on `127.0.0.1`, and Chromium resolves `*.localhost` itself. `pnpm dev` restarts automatically when SDK sources change. UI edits hot-reload without restarting running apps.

## Layout

| Package                        | What it is                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/sdk`](packages/sdk) | The runtime: bundle verification, the local host (HTTP router, Wisp relay, OS listeners, library store), the in-app compatibility layer, the controlled-frame proxy, and the browser SDK. |
| [`packages/ui`](packages/ui)   | The launcher (React + Vite). It includes a library, install by file, drop, or URL, app windows, permission prompts, developer tools, and app details. It uses only the public SDK.        |

## The launcher

- **Library:** installed apps with icons, versions, and capability chips. **Try an app** lists built-in examples (Controlled Frame Lab and Socket Lab) and public IWAs that install from their publishers' URLs.
- **App view:** running apps stay alive in the sidebar while you switch between them. The toolbar shows the `isolated-app://` URL, home, reload, developer tools, and app info.
- **Permission prompts:** when an app first needs your local network, Iyowa asks in an anchored prompt. Your answer is saved per app and can be changed later.
- **Developer tools:** the app's console with level filters, every Direct Socket with its route and byte counts, permissions, and the parsed manifest.
- **App info:** bundle ID, origin, digest, size, signature status, shortcuts, protocol handlers, **Check for updates** through `update_manifest_url`, and **Remove**.

## Permission model

Manifest `permissions_policy` decides what an app may request. Iyowa grants the declared IWA features, as Chrome does for an installed IWA. You decide one thing: **local network access**.

| Capability                                      | Needs                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sockets to public internet addresses            | `direct-sockets` and `cross-origin-isolated`                                            |
| Sockets to loopback/LAN, and real OS listeners  | additionally `direct-sockets-private`, and you **allow** local network access           |
| Controlled frames showing public sites          | `controlled-frame` (or the pre-standard `controlledframe`) and `cross-origin-isolated`  |
| Controlled frames showing LAN or loopback pages | additionally, you **allow** local network access                                        |
| `getAllScreensMedia()`                          | `all-screens-capture`. It opens Chromium's share picker with entire screens preselected |

The relay enforces policy at the address it actually connects to, after DNS resolution, so a public name can't rebind to a private address. **Block** doesn't break apps: loopback listeners and connections stay on an in-tab network shared by the app's windows and workers.

## Direct Sockets

`TCPSocket`, `TCPServerSocket`, and `UDPSocket` follow the [Direct Sockets](https://wicg.github.io/direct-sockets/) API, including streams, BYOB reads, EOF, `opened` and `closed`, bound and connected UDP, and the multicast controller. Each socket takes one of three routes, shown in developer tools:

| Route       | When                                                              | How                                                                                                                               |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **in-app**  | Loopback without local network access                             | A SharedWorker hub per app, so windows and dedicated workers can listen and connect to each other                                 |
| **network** | Outgoing TCP and UDP                                              | [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) v2 via `wisp-js`. `opened` resolves after the remote handshake completes |
| **system**  | `TCPServerSocket` and bound `UDPSocket` with local network access | Real OS sockets on this computer that other programs can reach                                                                    |

## Controlled frames

`<controlledframe>` uses a [Scramjet](https://github.com/MercuryWorkshop/scramjet) v2 proxy, the core behind browser.js. It never uses a native cross-origin iframe or an external link. Each app and partition gets its own origin, `p-<hash>.localhost`, with a Scramjet service worker. Pages are fetched with [libcurl.js](https://github.com/ading2210/libcurl.js) over that partition's Wisp relay, so TLS terminates in the browser and framing headers such as `X-Frame-Options` don't apply. Pages with WebSockets, cookies, and redirects work. `persist:` partitions keep cookies and storage across launches.

The element supports navigation and history, all load events, `executeScript` and `insertCSS` (with code or bundled files), content scripts, `request.createWebRequestInterceptor` (block, rewrite request headers, observe responses), `contextMenus`, `newwindow` with `attach` and `discard`, `clearData`, zoom, audio muting, a user-agent override, `find`, and `print`. See [compatibility](docs/compatibility.md) for the edges.

## Using the SDK

Browser API (`@iyowa/sdk`, also served as `/sdk.js` by the host):

```js
import { IwaRuntime } from "/sdk.js";

const runtime = new IwaRuntime();
const app = await runtime.install(file); // or runtime.installURL("https://…/update.json")
const session = runtime.launch(app, document.querySelector("main"));
session.addEventListener("permissionrequest", (e) =>
	e.respond(confirm(`${app.name}: ${e.reason}?`) ? "granted" : "denied"),
);
session.addEventListener("console", (e) => console.log(e.detail));
await session.ready;
```

| API                                                                      | Behavior                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list()`, `examples()`, `install(blob)`, `installURL(url, {channel?})`   | Library. Installs verify the signature. Updates must keep the signing key, downgrades are refused, and an update manifest selects the newest version on the channel.                 |
| `update(app)`, `remove(id)`, `setPermission(id, "local-network", state)` | Maintenance. `change` events fire on the runtime.                                                                                                                                    |
| `launch(app, element, {path?})` → `IwaSession`                           | Starts the app in a new frame. Sessions expose `frame`, `ready`, `url`, `title`, `console`, `sockets`, `navigate`, `reload`, and `stop`.                                             |
| `session` events                                                         | `ready`, `title`, `console`, `socket`, `update`, `stop`, and `permissionrequest` (`PermissionRequestEvent`: `name`, `reason`, `respond()`). Without a listener, requests are denied. |
| `session.openProtocol(url)`, `session.deliverLaunch(url)`                | Manifest `protocol_handlers` and `launchQueue`                                                                                                                                       |

Node API: `@iyowa/sdk/host` exports `createHost({ port, dataDir, ui })`, where `ui` is a static directory or a connect-style handler with an optional `upgrade` hook. `@iyowa/sdk/bundle` exports `readBundle(bytes)` for offline verification. `@iyowa/sdk/build` builds the runtime assets. Use `port: 0` for an ephemeral test host.

## Tests

```sh
pnpm exec playwright install chromium   # once
pnpm check                              # Biome + strict TypeScript
pnpm test                               # unit tests, SDK and launcher end-to-end tests in Chromium
pnpm test:public                        # also download pinned upstream IWAs and run them unmodified
```

Fixtures and examples are signed with deterministic **public** demo keys. Upstream bundles are pinned by SHA-256 in [`packages/sdk/scripts/public.ts`](packages/sdk/scripts/public.ts) and cached in `.cache/public`.
