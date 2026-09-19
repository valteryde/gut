// Custom updater — adapted from regne's macUpdater.
//
// Why not electron-updater: its macOS path needs a signed + notarized app
// (Squirrel/zip install is Gatekeeper-blocked otherwise), i.e. a paid Apple
// dev account. This updater fetches the release .zip straight from GitHub,
// extracts it with ditto, and swaps the .app bundle via a detached script —
// the quarantine strip is what makes an unsigned update launchable.
//
// macOS: full self-update. Windows/Linux: check reports the new version and
// 'download' opens the release page (NSIS/AppImage self-swap unsigned is
// flaky — not worth it).
const { app, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'valteryde/gut';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

class Updater {
  constructor() {
    this.stagedAppPath = null;
    this.stagedVersion = null;
    this.latest = null; // {version, tag, url, notes, assets}
  }

  /** Check GitHub for a newer release. Returns the release info or null. */
  async check() {
    const res = await net.fetch(RELEASES_API, {
      headers: { 'User-Agent': 'gut-app', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`release check failed: HTTP ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || !semverGt(version, app.getVersion())) {
      this.latest = null;
      return null;
    }
    this.latest = {
      version,
      tag: rel.tag_name,
      url: rel.html_url,
      notes: rel.body || '',
      assets: (rel.assets || []).map((a) => ({
        name: a.name, url: a.browser_download_url,
      })),
    };
    return this.latest;
  }

  /** Pick the release zip matching this arch (mac) — same matching as regne. */
  _zipAsset() {
    const isArm64 = process.arch === 'arm64';
    const zips = (this.latest?.assets || [])
      .filter((a) => a.name.toLowerCase().endsWith('.zip'));
    return zips.find((a) => isArm64
      ? a.name.includes('arm64') || a.name.includes('aarch64')
      : !a.name.includes('arm64') && !a.name.includes('aarch64')) || zips[0];
  }

  /**
   * Download the staged release zip, extract with ditto (preserves symlinks
   * and permissions), locate the .app bundle. Returns {version} when staged.
   */
  async download(onProgress) {
    if (process.platform !== 'darwin') {
      // Other platforms: hand off to the release page.
      if (this.latest?.url) shell.openExternal(this.latest.url);
      return { manual: true };
    }
    if (!this.latest) throw new Error('no update checked in');
    const asset = this._zipAsset();
    if (!asset) throw new Error('no .zip asset in the latest release');

    const stagingDir = path.join(app.getPath('userData'), 'pending-update');
    fs.mkdirSync(stagingDir, { recursive: true });
    const zipPath = path.join(stagingDir, 'update.zip');
    fs.rmSync(zipPath, { force: true });

    const res = await net.fetch(asset.url, {
      headers: { 'User-Agent': 'gut-app' },
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

    const totalBytes = Number(res.headers.get('content-length') || 0);
    const file = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    let transferred = 0, lastTime = Date.now(), lastTransferred = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!file.write(Buffer.from(value))) {
        await new Promise((r) => file.once('drain', r));
      }
      transferred += value.length;
      const now = Date.now(), elapsed = (now - lastTime) / 1000;
      if (elapsed >= 0.25) {
        onProgress?.({
          percent: totalBytes ? Math.round((transferred / totalBytes) * 1000) / 10 : 0,
          bytesPerSecond: Math.round((transferred - lastTransferred) / elapsed),
          transferred, total: totalBytes || transferred,
        });
        lastTime = now; lastTransferred = transferred;
      }
    }
    await new Promise((resolve, reject) =>
      file.end((err) => (err ? reject(err) : resolve())));
    onProgress?.({ percent: 100, bytesPerSecond: 0, transferred, total: transferred });

    const extractDir = path.join(stagingDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await new Promise((resolve, reject) =>
      execFile('/usr/bin/ditto', ['-xk', zipPath, extractDir],
        (err, _o, stderr) => err
          ? reject(new Error(`extract failed: ${stderr || err.message}`))
          : resolve()));
    fs.rmSync(zipPath, { force: true });

    const appItem = fs.readdirSync(extractDir).find((i) => i.endsWith('.app'));
    if (!appItem) throw new Error('update archive had no .app bundle');
    this.stagedAppPath = path.join(extractDir, appItem);
    this.stagedVersion = this.latest.version;
    return { version: this.stagedVersion };
  }

  isReady() {
    return !!this.stagedAppPath && fs.existsSync(this.stagedAppPath);
  }

  /**
   * Swap the staged .app over the installed one via a detached script that
   * waits for this process to die first. Quarantine is stripped so the
   * unsigned replacement launches without a Gatekeeper prompt.
   */
  applyAndRestart() {
    if (!this.isReady()) throw new Error('no staged update');
    const targetAppPath = app.isPackaged
      ? path.resolve(process.execPath, '../../..')
      : '/Applications/gut.app';
    const pid = process.pid;
    const scriptDir = path.join(app.getPath('userData'), 'updater');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'install-update.sh');
    const stagingDir = path.dirname(this.stagedAppPath);

    fs.writeFileSync(scriptPath, `#!/bin/bash
while kill -0 ${pid} 2>/dev/null; do sleep 0.1; done
sleep 0.5
rm -rf "${targetAppPath}"
cp -Rp "${this.stagedAppPath}" "${targetAppPath}"
xattr -cr "${targetAppPath}" 2>/dev/null || true
open "${targetAppPath}"
rm -rf "${stagingDir}" "${scriptPath}" 2>/dev/null || true
`, { mode: 0o755 });

    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }
}

module.exports = new Updater();
