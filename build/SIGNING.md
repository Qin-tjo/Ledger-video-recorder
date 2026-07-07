# Signing notes (macOS)

Ledger Video Recorder ships **unsigned** by default (no Apple Developer certificate). That's fine for a
free release, but there are two rough edges worth understanding.

## The two options

| | Cost | Gatekeeper warning | Screen-recording permission on updates |
|---|---|---|---|
| **Unsigned / ad-hoc** (default, incl. CI builds) | $0 | Yes (users click "Open Anyway" once) | **Resets each update** — user must re-grant |
| **Self-signed cert** (local builds) | $0 | Yes (still not notarized) | **Persists across updates** ✅ |
| **Apple Developer ID + notarization** | $99/yr | None | Persists ✅ |

macOS ties the Screen Recording grant to the app's **code signature**. An unsigned/ad-hoc
build's signature changes with every release, so the OS forgets the permission on each
update. A **stable self-signed certificate** keeps the signature identity constant, so the
permission sticks — for **$0**. It does *not* remove the first-launch Gatekeeper warning
(only notarization does that).

## Building locally with a self-signed certificate (optional, recommended)

1. **Create the certificate once** (Keychain Access):
   - Keychain Access → menu **Certificate Assistant → Create a Certificate…**
   - Name: `Ledger Video Recorder Self-Signed`
   - Identity Type: **Self-Signed Root**
   - Certificate Type: **Code Signing**
   - Create it. It now lives in your login keychain.

2. **Build, telling electron-builder to use it** (no repo changes needed):

   ```bash
   CSC_NAME="Ledger Video Recorder Self-Signed" npm run dist:mac
   ```

   electron-builder signs the app with that identity. The resulting `.dmg` in `dist/` has a
   stable signature, so updates won't reset users' screen-recording permission.

> The project's `afterSign` hook (`build/notarize.cjs`) only notarizes when Apple
> credentials are present in the environment, so it's a no-op here — no interference.

## CI builds

`.github/workflows/release.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: false`, so CI produces
**unsigned** builds (there's no certificate on the runner). If you later want CI to sign
with your self-signed cert, export it as a `.p12`, base64-encode it into a repo secret, and
set `CSC_LINK` / `CSC_KEY_PASSWORD` in the workflow.

## Upgrading to a clean install later

When you're ready to remove the Gatekeeper warning entirely, join the Apple Developer
Program ($99/yr) and set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` before `npm run dist:mac` — the existing
`afterSign` hook will notarize automatically. See the main README's packaging section.
