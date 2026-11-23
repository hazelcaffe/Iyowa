# Iyowa

[![CI](https://github.com/hazelcaffe/Iyowa/actions/workflows/ci.yml/badge.svg)](https://github.com/hazelcaffe/Iyowa/actions/workflows/ci.yml)

Run signed [Isolated Web Apps](https://github.com/WICG/isolated-web-apps) (`.swbn`) in a normal Chromium tab. Iyowa verifies the bundle, serves the app from its own `localhost` origin, and emulates the IWA APIs: Direct Sockets, Controlled Frame, `getAllScreensMedia`, unframed display mode, `launchQueue` and protocol handlers. Upstream apps such as the [ChromeOS Kitchen Sink](https://github.com/chromeos/iwa-sink) run unmodified.

Iyowa is a compatibility environment, not ChromeOS's IWA security model. Only install bundles you trust. Known differences are listed in [docs/compatibility.md](docs/compatibility.md).

## Run

Requires Node.js 24 or newer and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev        # http://localhost:4178
```

`pnpm build && pnpm start` serves the production build. `PORT` sets the port; keep it stable, because each app's browser storage belongs to its origin. `IYOWA_DATA` sets the data directory (default `./.iyowa`). The server only listens on `127.0.0.1`.

Install an app from **Install** (a `.swbn` file, a bundle or `update.json` URL, an example, or a public app), or drop a `.swbn` on the page. Choose it at the top and press **Run**; **Stop** closes it. Running apps get tabs. **Logs** (Ctrl+\`) shows runtime and app output, **Sockets** shows the active app's connections, and **Settings** has the app's permissions, details, updates and removal.

## Permissions

The manifest's `permissions_policy` decides which APIs an app gets. Iyowa only asks about local network access:

- `direct-sockets`: connections to public addresses. Loopback stays on a network inside the app.
- `direct-sockets-private`: with your permission, connections to this computer and the LAN, and real OS listeners.
- `controlled-frame`: frames load public sites. LAN sites need your permission.

The relay checks the resolved address before it connects. Answers are saved per app and can be changed in **Settings**.

## How it works

- Controlled frames run through a per-partition [Scramjet](https://github.com/MercuryWorkshop/scramjet) v2 service worker. Pages are fetched with [libcurl.js](https://github.com/ading2210/libcurl.js) over [Wisp](https://github.com/MercuryWorkshop/wisp-protocol), so TLS terminates in the browser.
- Outgoing TCP and UDP use Wisp, loopback inside an app uses a SharedWorker, and OS listeners use a small bind protocol on the host.

More in [docs/architecture.md](docs/architecture.md). The SDK is documented in [docs/sdk.md](docs/sdk.md).

## Layout

- `packages/sdk` (`@iyowa/sdk`): bundle verification, the Node host, the in-app runtime, the controlled-frame proxy and the browser SDK.
- `packages/ui` (`@iyowa/ui`): the launcher, a React and Mantine app that only uses the SDK.
- `packages/site`: the docs site at https://hazelcaffe.github.io/Iyowa/.

## Tests

```sh
pnpm check                              # Biome and TypeScript
pnpm exec playwright install chromium   # once
pnpm test                               # unit and Chromium end-to-end tests
pnpm test:public                        # also runs pinned upstream IWAs (needs network)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). Scramjet is AGPL-3.0-only; libcurl.js and wisp-js are LGPL-3.0-or-later. The example apps are signed with public demo keys.
