/**
 * electron-builder afterSign hook — ad-hoc code signing.
 *
 * Runs after electron-builder's signing phase (skipped when identity=null)
 * and BEFORE the DMG is packaged, so the DMG ships the signed .app.
 *
 * Ad-hoc signing (-) satisfies Gatekeeper's structural requirements and
 * prevents macOS from flagging the PyInstaller bundle as malware.
 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`\nAd-hoc signing: ${appPath}`);
  try {
    execFileSync('codesign', [
      '--sign', '-',
      '--force',
      '--deep',
      '--preserve-metadata=entitlements,requirements,flags',
      appPath,
    ], { stdio: 'inherit' });
    console.log('Ad-hoc signing complete.\n');
  } catch (err) {
    console.warn('codesign failed (non-fatal on non-macOS runner):', err.message);
  }
};
