# Contributing to Iyowa

Thanks for helping. Bug reports with a real IWA, compatibility fixes, tests and docs are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 24 or newer, [Corepack](https://nodejs.org/api/corepack.html) (bundled with Node) and a Chromium-based browser.

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
pnpm dev                 # http://localhost:4178
```

`pnpm dev` rebuilds the SDK runtime at startup and restarts when files in `packages/sdk/src` or `packages/sdk/fixtures` change. Launcher changes in `packages/ui/src` hot-reload without restarting running apps. Data goes to `./.iyowa`. Use `IYOWA_DATA=/tmp/iyowa pnpm dev` for a throwaway library.

## Where things live

| Path                       | Contents                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/sdk/src/bundle`  | Signed Web Bundle parsing and verification                                                            |
| `packages/sdk/src/host`    | Node host: HTTP router, store, Wisp relay, OS listeners, downloads                                    |
| `packages/sdk/src/runtime` | Scripts injected into app documents and workers (sockets, controlled frame, capture, display, popups) |
| `packages/sdk/src/frame`   | The controlled-frame proxy: Scramjet service worker, page client, libcurl network worker              |
| `packages/sdk/src/client`  | The browser SDK (`IwaRuntime`, `IwaSession`)                                                          |
| `packages/sdk/fixtures`    | Signed test and example apps (`probe.ts`, `labs.ts`)                                                  |
| `packages/ui`              | The React launcher                                                                                    |
| `packages/site`            | The GitHub Pages generator, which renders `docs/*.md`                                                 |

[How Iyowa works](docs/architecture.md) explains how these pieces fit together.

## Checks and tests

```sh
pnpm check          # Biome (lint and format) and strict TypeScript; `pnpm format` fixes formatting
pnpm test           # builds, then runs unit tests and every Playwright suite
pnpm test:public    # also downloads the pinned upstream IWAs and runs them unmodified (needs network)
```

Add a test with every behavior change:

- **Bundle, store or policy logic:** `packages/sdk/tests/*.test.ts` (Node's test runner).
- **Runtime behavior:** `packages/sdk/tests/e2e/runtime.spec.ts`. Tests launch the signed `probe` fixture through a minimal SDK harness and run real sockets and servers on loopback. If the fixture needs a page or a manifest change, extend `packages/sdk/fixtures/probe.ts`.
- **A real app's workflow:** `packages/sdk/tests/e2e/public.spec.ts`. Pin new upstream bundles by SHA-256 in `packages/sdk/scripts/public.ts`. Never commit third-party bundles.
- **Launcher:** `packages/ui/tests/ui.spec.ts`, using accessible roles and names where possible.

## Conventions

- TypeScript is strict ESNext. Biome formats with tabs (width 4), double quotes and semicolons.
- Host and script code runs through Node's type stripping, so avoid `enum`, parameter properties and other syntax that isn't erasable.
- In `src/frame/client.ts`, capture platform functions **before** `ScramjetClient.hook()` runs. Scramjet rewrites message origins, `postMessage` and listener callbacks for the page.
- Changes to example apps in `fixtures/labs.ts` need a version bump. Iyowa refuses to replace an installed version with different contents.
- Keep the launcher on the public SDK. If the UI needs something new, add it to `@iyowa/sdk` first.
- Run `pnpm screenshots` after visible UI changes and commit the updated `docs/assets/*.png`. It needs `pnpm build`, the public bundle cache, and network access.
- Preview docs changes with `pnpm --filter @iyowa/site preview`.

## Pull requests

Keep each PR focused, describe what changed and how you verified it, and make sure `pnpm check` and `pnpm test` pass. If a change affects compatibility, update [docs/compatibility.md](docs/compatibility.md).

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0-or-later](LICENSE) license.
