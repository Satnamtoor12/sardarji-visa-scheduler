// GitHub auto-update helpers (imported by background.js)

const GITHUB_REPO = 'SatnamSinghToor/SardarJi-Visa-Scheduler';
const GITHUB_MANIFEST_URL =
  'https://raw.githubusercontent.com/' + GITHUB_REPO + '/main/manifest.json';
const NATIVE_HOST = 'com.sardarji.updater';
const UPDATE_CHECK_COOLDOWN_MS = 60 * 1000;
const BOOTSTRAP_RETRY_MS = 15 * 1000;

function parseVersion(v) {
  return String(v || '0').split('.').map(function(n) { return parseInt(n, 10) || 0; });
}

function compareVersion(a, b) {
  var pa = parseVersion(a);
  var pb = parseVersion(b);
  var len = Math.max(pa.length, pb.length);
  for (var i = 0; i < len; i++) {
    var da = pa[i] || 0;
    var db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function notifyUpdaterStatus(state, detail) {
  chrome.runtime.sendMessage(
    { type: 'UPDATER_STATUS', state: state, detail: detail || '' },
    function() { void chrome.runtime.lastError; }
  );
}

function fetchRemoteVersion() {
  return fetch(GITHUB_MANIFEST_URL, { cache: 'no-store' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) { return data && data.version ? data.version : null; });
}

function shouldSkipUpdateCheck() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['lastUpdateCheckAt'], function(d) {
      var last = d.lastUpdateCheckAt || 0;
      resolve(Date.now() - last < UPDATE_CHECK_COOLDOWN_MS);
    });
  });
}

function markUpdateCheckDone() {
  chrome.storage.local.set({ lastUpdateCheckAt: Date.now() });
}

function tryNativePing() {
  return new Promise(function(resolve) {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, function(resp) {
      resolve(!chrome.runtime.lastError && resp && resp.success);
    });
  });
}

function tryNativeGitHubSync() {
  return new Promise(function(resolve) {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'update' }, function(resp) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, resp: resp || {} });
    });
  });
}

function bootstrapScriptForPlatform(os) {
  var cloneUrl = 'https://github.com/' + GITHUB_REPO + '.git';

  if (os === 'win') {
    return [
      '@echo off',
      'set "REPO=%USERPROFILE%\\SardarJi-Visa-Scheduler"',
      'if not exist "%REPO%\\native-host\\install.ps1" (',
      '  git clone ' + cloneUrl + ' "%REPO%"',
      ')',
      'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%REPO%\\native-host\\install.ps1"',
      'exit /b %ERRORLEVEL%'
    ].join('\r\n');
  }

  if (os === 'mac') {
    return [
      '#!/bin/bash',
      'REPO="$HOME/SardarJi-Visa-Scheduler"',
      'if [ ! -f "$REPO/native-host/install.sh" ]; then',
      '  git clone ' + cloneUrl + ' "$REPO"',
      'fi',
      'bash "$REPO/native-host/install.sh"'
    ].join('\n');
  }

  return [
    '#!/bin/bash',
    'REPO="$HOME/SardarJi-Visa-Scheduler"',
    'if [ ! -f "$REPO/native-host/install.sh" ]; then',
    '  git clone ' + cloneUrl + ' "$REPO"',
    'fi',
    'bash "$REPO/native-host/install.sh"'
  ].join('\n');
}

function bootstrapFilename(os) {
  if (os === 'win') return 'SardarJi-Setup.bat';
  if (os === 'mac') return 'SardarJi-Setup.command';
  return 'SardarJi-Setup.sh';
}

function shouldRetryBootstrap() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['lastBootstrapAt'], function(d) {
      var last = d.lastBootstrapAt || 0;
      resolve(Date.now() - last >= BOOTSTRAP_RETRY_MS);
    });
  });
}

function markBootstrapAttempt() {
  chrome.storage.local.set({ lastBootstrapAt: Date.now() });
}

function downloadAndLaunchBootstrap() {
  return new Promise(function(resolve) {
    chrome.runtime.getPlatformInfo(function(info) {
      var os = info && info.os ? info.os : 'win';
      var content = bootstrapScriptForPlatform(os);
      var filename = bootstrapFilename(os);
      var blob = new Blob([content], { type: 'application/octet-stream' });
      var blobUrl = URL.createObjectURL(blob);

      chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        conflictAction: 'overwrite',
        saveAs: false
      }, function(downloadId) {
        if (chrome.runtime.lastError || !downloadId) {
          URL.revokeObjectURL(blobUrl);
          resolve(false);
          return;
        }

        function onChanged(delta) {
          if (delta.id !== downloadId || !delta.state) return;
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            URL.revokeObjectURL(blobUrl);
            chrome.downloads.open(downloadId);
            resolve(true);
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            URL.revokeObjectURL(blobUrl);
            resolve(false);
          }
        }

        chrome.downloads.onChanged.addListener(onChanged);
      });
    });
  });
}

function ensureNativeHostReady() {
  return tryNativePing().then(function(ready) {
    if (ready) return true;

    return shouldRetryBootstrap().then(function(canRetry) {
      if (!canRetry) return false;

      notifyUpdaterStatus('bootstrapping', 'Setting up auto-update...');
      if (typeof addLog === 'function') {
        addLog('Setting up GitHub auto-update...');
      }

      markBootstrapAttempt();
      return downloadAndLaunchBootstrap().then(function(launched) {
        if (!launched) return false;
        return delay(3500).then(function() { return tryNativePing(); });
      });
    });
  });
}

function applyNativeSyncResult(native, localVersion, needsUpdate) {
  if (!native.ok) return false;

  var r = native.resp || {};
  if (r.success && (r.changed || needsUpdate)) {
    notifyUpdaterStatus('updating', r.version ? 'v' + r.version : '');
    if (typeof addLog === 'function') {
      addLog('GitHub update applied' + (r.version ? ' (v' + r.version + ')' : '') + ' — reloading...');
    }
    setTimeout(function() { chrome.runtime.reload(); }, 400);
    return true;
  }

  if (r.success) {
    notifyUpdaterStatus('ready', 'v' + localVersion);
    if (typeof addLog === 'function') {
      addLog('Extension up to date (v' + localVersion + ').');
    }
  }
  return false;
}

// Icon click: ensure native host, sync from GitHub, reload if changed.
function tryAutoUpdateFromGitHub() {
  return shouldSkipUpdateCheck().then(function(skip) {
    if (skip) return false;

    var localVersion = chrome.runtime.getManifest().version;
    notifyUpdaterStatus('checking', 'v' + localVersion);

    return fetchRemoteVersion()
      .then(function(remoteVersion) {
        markUpdateCheckDone();
        if (!remoteVersion) return false;

        var needsUpdate = compareVersion(remoteVersion, localVersion) > 0;
        return ensureNativeHostReady().then(function() {
          return tryNativeGitHubSync().then(function(native) {
            return applyNativeSyncResult(native, localVersion, needsUpdate);
          });
        });
      })
      .catch(function(err) {
        markUpdateCheckDone();
        notifyUpdaterStatus('idle', '');
        if (typeof addLog === 'function') {
          addLog('Update check failed: ' + (err && err.message ? err.message : 'network error'));
        }
        return false;
      });
  });
}