// electron-builder afterSign hook: notarizes the macOS app, but ONLY when Apple
// credentials are present in the environment. This keeps unsigned local builds
// (`npm run pack`) working without any setup.
//
// To enable notarization, set before running `npm run dist:mac`:
//   APPLE_ID                     your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  an app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                your 10-char Developer Team ID
// and provide a Developer ID Application certificate via CSC_LINK / CSC_KEY_PASSWORD.

const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`[notarize] Notarizing ${appName}…`)

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  })

  console.log('[notarize] Done.')
}
