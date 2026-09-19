// Brands the dev Electron.app (name + icon) so `npm start` shows "gut" in
// the dock instead of stock Electron. No-op off macOS or before install.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function brandElectron() {
  if (process.platform !== 'darwin') return;

  const electronAppPath =
    path.join(__dirname, '../node_modules/electron/dist/Electron.app');
  if (!fs.existsSync(electronAppPath)) return;

  const infoPlistPath = path.join(electronAppPath, 'Contents/Info.plist');
  const icnsSourcePath = path.join(__dirname, '../resources/icon.icns');
  const icnsDestPath =
    path.join(electronAppPath, 'Contents/Resources/electron.icns');

  try {
    if (fs.existsSync(infoPlistPath)) {
      execSync(`plutil -replace CFBundleName -string "gut" "${infoPlistPath}"`,
        { stdio: 'ignore' });
      execSync(`plutil -replace CFBundleDisplayName -string "gut" "${infoPlistPath}"`,
        { stdio: 'ignore' });
    }
    if (fs.existsSync(icnsSourcePath)) {
      fs.copyFileSync(icnsSourcePath, icnsDestPath);
    }
  } catch (err) {
    console.warn('[brand-electron] could not brand Electron.app:', err.message);
  }
}

brandElectron();
