/**
 * electron-builder afterPack hook.
 *
 * Strips macOS extended attributes (resource forks, Finder metadata) from the
 * packaged .app bundle before code signing. Without this, codesign fails with
 * "resource fork, Finder information, or similar detritus not allowed" on
 * Electron helper binaries.
 */

const { execSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return;

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[afterPack] Stripping extended attributes from ${appPath}`);
  execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
};
