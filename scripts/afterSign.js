/**
 * electron-builder afterSign hook — ad-hoc code signing (bottom-up).
 *
 * --deep is unreliable for Electron Framework; we sign components
 * from innermost to outermost so each bundle's signature is valid
 * before its parent is signed.
 */

const { execFileSync, execSync } = require('child_process');
const { readdirSync, statSync } = require('fs');
const path = require('path');

function isMachO(filePath) {
  try {
    const out = execSync(`file "${filePath}"`, { encoding: 'utf8' });
    return out.includes('Mach-O');
  } catch {
    return false;
  }
}

function findRecursive(dir, test) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) results.push(...findRecursive(full, test));
    else if (test(entry.name, full)) results.push(full);
  }
  return results;
}

function sign(target) {
  try {
    execFileSync('codesign', ['--sign', '-', '--force', target], { stdio: 'pipe' });
  } catch (e) {
    console.warn(`  codesign skipped: ${path.basename(target)} — ${e.message.trim()}`);
  }
}

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const fwDir   = path.join(appPath, 'Contents', 'Frameworks');

  console.log(`\nAd-hoc signing (bottom-up): ${appPath}`);

  // 1 — binaries inside Electron Framework
  const efDir = path.join(fwDir, 'Electron Framework.framework');
  const binaries = findRecursive(efDir, (name, full) => {
    return isMachO(full);
  });
  for (const b of binaries) sign(b);
  sign(efDir);

  // 2 — other frameworks and helper .app bundles
  for (const entry of readdirSync(fwDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(fwDir, entry.name);
    if (entry.name === 'Electron Framework.framework') continue;
    if (entry.name.endsWith('.framework') || entry.name.endsWith('.app')) {
      sign(full);
    }
  }

  // 3 — main app bundle
  sign(appPath);

  console.log('Ad-hoc signing complete.\n');
};
