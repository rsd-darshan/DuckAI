/**
 * Post-sign notarization hook for electron-builder.
 * Only runs when APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD are set (CI/release builds).
 * Safe to skip locally — notarization is only needed for distribution.
 */
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword) {
    console.log("Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD not set.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);
  await notarize({
    tool: "notarytool",
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log("Notarization complete.");
};
