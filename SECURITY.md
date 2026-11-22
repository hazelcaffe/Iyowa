# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through [GitHub's private vulnerability reporting](https://github.com/hazelcaffe/Iyowa/security/advisories/new), or email hazel@qwq.sh. Include the affected commit, steps to reproduce, and if possible a minimal bundle or page that demonstrates the issue. You should get a reply within a week.

Fixes land on `main`. There are no maintained release branches yet.

## What counts

Iyowa runs apps the user chose to install, on origins served by a local process. Reports are especially welcome for problems that cross one of these boundaries:

- **Bundle verification:** a bundle that installs or runs under an ID whose key didn't sign it, or tampered content that passes verification.
- **Network policy:** reaching loopback or private addresses through the Wisp relay, OS listeners or a controlled frame without the app's local network grant. This includes DNS rebinding.
- **Origin isolation:** one app or frame partition reading another's storage or messages, or a web page in a controlled frame scripting the app that embeds it.
- **Host exposure:** any way for a website you visit, or another machine, to use the host's API, install apps, or change permissions.

Known differences from ChromeOS are listed in [docs/compatibility.md](docs/compatibility.md). For example, Iyowa doesn't give ChromeOS's process-level IWA isolation. Those differences are design limits, not vulnerabilities, but reports that show a practical attack on them are still useful.
