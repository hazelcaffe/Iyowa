# SDK reference

`@iyowa/sdk` has two halves: a **browser API**, which drives the library and runs apps from a page on the launcher origin, and a **Node API**, which runs the host. The launcher in `packages/ui` uses nothing else, so any UI can replace it.

## Browser

The host serves the SDK as an ES module at `/sdk.js`. Inside this workspace, import it as `@iyowa/sdk`.

```js
import { IwaRuntime } from "/sdk.js";

const runtime = new IwaRuntime();
const [app] = await runtime.list();
const session = runtime.launch(app, document.querySelector("#stage"));

session.addEventListener("permissionrequest", (event) => {
	// event.name === "local-network"; event.reason describes what the app tried to do.
	event.respond(confirm(`${app.name} wants to ${event.reason}`) ? "granted" : "denied");
});
session.addEventListener("console", (event) => console.log(`[${app.name}]`, event.detail.message));
await session.ready;
```

### `IwaRuntime`

| Member                                             | Description                                                                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new IwaRuntime({ host? })`                        | `host` defaults to the current origin. Library calls must come from the launcher origin.                                                                                                             |
| `list()` → `AppInfo[]`                             | Installed apps.                                                                                                                                                                                      |
| `examples()` → `ExampleInfo[]`                     | Built-in example bundles served by the host.                                                                                                                                                         |
| `install(bundle)` → `AppInfo`                      | Verifies and installs a `Blob`, `ArrayBuffer` or `Uint8Array`. Reinstalling the same ID must be a newer version, or the identical bundle.                                                            |
| `installURL(url, { channel?, expectedId? })`       | Installs from a public HTTPS `.swbn`, or from an [update manifest](https://github.com/WICG/isolated-web-apps/blob/main/Updates.md), which picks the newest version on `channel` (default `default`). |
| `update(app, channel?)`                            | Follows `update_manifest_url`. The update must be signed by the same key.                                                                                                                            |
| `remove(id)`                                       | Stops the app's sessions and deletes the package. Browser storage for the app's origin isn't cleared.                                                                                                |
| `setPermission(id, "local-network", state)`        | `state` is `"prompt"`, `"granted"` or `"denied"`. Running sessions are updated.                                                                                                                      |
| `iconURL(app)`                                     | Absolute URL of the best manifest icon, if there is one.                                                                                                                                             |
| `launch(app, container, { path? })` → `IwaSession` | Appends a new app frame to `container`. An existing session of the same app is stopped first.                                                                                                        |
| `sessions()`, `session(id)`                        | Running sessions.                                                                                                                                                                                    |
| events                                             | `change` (the library or an app changed) and `sessions` (a session started or stopped).                                                                                                              |

`AppInfo` includes `id`, `origin` (`isolated-app://…`), `appOrigin` (the real origin), `name`, `version`, `manifest`, `permissions`, `size`, `digest`, `exchanges`, `startPath`, `installedAt`, and `icon`.

### `IwaSession`

| Member                                 | Description                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `frame`                                | The app's `<iframe>`. Moving it to another parent reloads the app, so keep it in one container.   |
| `ready`                                | Resolves when the first document has loaded. Rejects after 30 seconds or on `stop()`.             |
| `url`, `title`                         | Current `isolated-app://` URL and document title.                                                 |
| `console`, `sockets`                   | Recent console entries (`{ id, level, message, time }`) and socket states (`SocketEvent`, by ID). |
| `navigate(path)`, `reload()`, `stop()` | `navigate` accepts a path or a same-app `isolated-app://` URL.                                    |
| `openProtocol(url)`                    | Opens a URL through the manifest's `protocol_handlers`.                                           |
| `deliverLaunch(targetURL, files?)`     | Delivers a launch to the app's `launchQueue` consumer.                                            |
| `clearConsole()`                       | Empties `console`.                                                                                |
| events                                 | `ready`, `title`, `console`, `socket`, `update`, `stop`, `permissionrequest`.                     |

`permissionrequest` is a `PermissionRequestEvent` with `name`, `reason`, and `respond("granted" | "denied")`, plus the shortcuts `allow()` and `deny()`. Call `preventDefault()` to answer later, for example from a prompt. With no listener, the request is denied. The answer is saved, so later requests resolve without an event.

Other exports: `allows(manifest, feature, id)`, `allowsIsolated(...)`, `runtimeFeatures` (labels for manifest features), `describeFeatures(app)`, and the shared types.

## Node

```ts
import { createHost } from "@iyowa/sdk/host";

const host = await createHost({
	port: 4178, // 0 picks a free port
	dataDir: "./.iyowa", // bundles and state.json
	ui: { dir: "./dist" }, // or { handler(req, res, next), upgrade?(req, socket, head) }
});
console.log(host.origin);
```

| Export              | Description                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@iyowa/sdk/host`   | `createHost(options)` returns `{ origin, port, list(), install(bytes), setPermission(id, name, state), close() }`.         |
| `@iyowa/sdk/bundle` | `readBundle(bytes)` (verify and index a bundle offline), `selectUpdate(manifest, channel)`, `compareVersions`, `bestIcon`. |
| `@iyowa/sdk/build`  | `buildSdk()` compiles the runtime assets and examples into `packages/sdk/dist`. The host needs them.                       |

The host listens only on `127.0.0.1`. It serves the launcher on `localhost:<port>`, apps on `<id>.localhost:<port>`, and frame partitions on `p-<hash>.localhost:<port>`. Library changes require a same-origin request from the launcher with the `X-Iyowa: 1` header.
