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
  // Packaged-contents gate (all platforms). The 0.10.0 macOS build shipped
  // without codex.js because the build.files whitelist was never updated
  // when the module landed; the app then died on its first require, after
  // install, where no test had ever looked. Every root-level local module
  // server.js requires must exist inside the packed asar, or the build
  // fails here, before signing and long before a user sees it.
  const fs = require('fs');
  const path = require('path');
  const asar = require(require.resolve('@electron/asar', { paths: [require.resolve('electron-builder')] }));
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  const required = [...serverSrc.matchAll(/require\('\.\/([\w-]+\.js)'\)/g)].map(m => m[1]);
  const resourcesDir = process.platform === 'darwin'
    ? `${context.appOutDir}/${context.packager.appInfo.productFilename}.app/Contents/Resources`
    : `${context.appOutDir}/resources`;
  const asarPath = path.join(resourcesDir, 'app.asar');
  const packed = new Set(asar.listPackage(asarPath).map(e => e.replace(/\\/g, '/')));
  const missing = required.filter(f => !packed.has(`/${f}`));
  if (missing.length) {
    throw new Error(`[afterPack] packaged app is missing required modules: ${missing.join(', ')}. Add them to build.files in package.json.`);
  }
  console.log(`[afterPack] packaged-contents gate: ${required.join(', ')} all present in app.asar`);

  if (process.platform !== 'darwin') return;

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`[afterPack] Stripping extended attributes from ${appPath}`);
  execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });
};
