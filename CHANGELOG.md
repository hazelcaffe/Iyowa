# Changelog

## 0.2.0 (2026-11-22)

First public release.

- **Packages:** the project is split into `@iyowa/sdk` (runtime, host and browser SDK) and `@iyowa/ui` (the launcher).
- **Launcher:** library with search, install by file, drop or URL, examples and a public catalog; multiple running apps; local network permission prompts; developer tools (console, sockets, permissions, manifest); app details with update checks and removal; light and dark themes.
- **Controlled Frame:** each partition gets a Scramjet v2 service worker that fetches through libcurl.js over Wisp, so TLS terminates in the browser and embedding headers don't apply. Cookies, WebSockets, request interception, context menus, `newwindow` and content scripts work, and the pre-standard `controlledframe` policy name is accepted.
- **Direct Sockets:** public destinations follow the manifest. Loopback, LAN and real OS listeners need the user's local network grant; otherwise loopback stays on an in-app network. `opened` resolves only after the remote TCP handshake completes.
- **Screen capture:** `getAllScreensMedia()` opens the share picker with screens preselected, and `display-capture` is delegated to the app frame.
- **Examples:** Controlled Frame Lab and Socket Lab.
- **Tests:** unit tests, SDK and launcher end-to-end tests, and pinned upstream IWAs (Kitchen Sink 1.7.0 and 0.1.0, the Windowing and Bundling examples).
