// GitHub auto-update helpers (imported by background.js)

const GITHUB_REPO = 'SatnamSinghToor/SardarJi-Visa-Scheduler';
const GITHUB_MANIFEST_URL =
  'https://raw.githubusercontent.com/' + GITHUB_REPO + '/main/manifest.json';
const NATIVE_HOST = 'com.sardarji.updater';
const UPDATE_CHECK_COOLDOWN_MS = 30 * 1000;
const BOOTSTRAP_RETRY_MS = 8 * 1000;

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

function fetchRemoteVersion() {
  return fetch(GITHUB_MANIFEST_URL, { cache: 'no-store' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) { return data && data.version ? data.version : null; });
}

function shouldSkipUpdateCheck(remoteVersion, localVersion) {
  if (compareVersion(remoteVersion, localVersion) > 0) {
    return Promise.resolve(false);
  }
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
  var repoWin = '%USERPROFILE%\\SardarJi-Visa-Scheduler';
  var repoUnix = '$HOME/SardarJi-Visa-Scheduler';

  if (os === 'win') {
    return [
      'Set sh = CreateObject("Wscript.Shell")',
      'repo = CreateObject("Wscript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & "\\SardarJi-Visa-Scheduler"',
      'Set fs = CreateObject("Scripting.FileSystemObject")',
      'If Not fs.FileExists(repo & "\\native-host\\install.ps1") Then',
      '  sh.Run "git clone ' + cloneUrl + ' "" & repo & """", 0, True',
      'End If',
      'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "" & repo & "\\native-host\\install.ps1""", 0, True'
    ].join('\r\n');
  }

  if (os === 'mac') {
    return [
      '#!/bin/bash',
      'REPO="$HOME/SardarJi-Visa-Scheduler"',
      'if [ ! -f "$REPO/native-host/install.sh" ]; then',
      '  git clone ' + cloneUrl + ' "$REPO"',
      'fi',
      'bash "$REPO/native-host/install.sh" </dev/null >/dev/null 2>&1 &'
    ].join('\n');
  }

  return [
    '#!/bin/bash',
    'REPO="$HOME/SardarJi-Visa-Scheduler"',
    'if [ ! -f "$REPO/native-host/install.sh" ]; then',
    '  git clone ' + cloneUrl + ' "$REPO"',
    'fi',
    'bash "$REPO/native-host/install.sh" </dev/null >/dev/null 2>&1 &'
  ].join('\n');
}

function bootstrapFilename(os) {
  if (os === 'win') return 'SardarJi-Setup.vbs';
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

      if (typeof addLog === 'function') {
        addLog('Setting up GitHub auto-update...');
      }

      markBootstrapAttempt();
      return downloadAndLaunchBootstrap().then(function(launched) {
        if (!launched) return false;
        return delay(4000).then(function() { return tryNativePing(); });
      });
    });
  });
}

function forceExtensionReload(reason) {
  if (typeof addLog === 'function') {
    addLog(reason || 'Reloading extension with latest code...');
  }
  setTimeout(function() { chrome.runtime.reload(); }, 300);
  return true;
}

function syncFromGitHubAndMaybeReload(localVersion, remoteVersion) {
  var needsUpdate = compareVersion(remoteVersion, localVersion) > 0;

  return ensureNativeHostReady()
    .then(function() { return tryNativeGitHubSync(); })
    .then(function(native) {
      if (native.ok) {
        var r = native.resp || {};
        if (r.success && r.changed && typeof addLog === 'function') {
          addLog('GitHub sync complete' + (r.version ? ' (v' + r.version + ')' : '') + '.');
        }
      } else if (needsUpdate && typeof addLog === 'function') {
        addLog('GitHub sync pending — reloading if newer code is on disk...');
      }

      if (needsUpdate) {
        return forceExtensionReload(
          'Update available (v' + remoteVersion + ') — reloading from disk...'
        );
      }

      if (native.ok && native.resp && native.resp.success && native.resp.changed) {
        return forceExtensionReload('Extension files updated — reloading...');
      }

      if (native.ok && native.resp && native.resp.success && typeof addLog === 'function') {
        addLog('Extension up to date (v' + localVersion + ').');
      }
      return false;
    });
}

// Icon click / sidebar open: sync from GitHub and reload when behind.
function tryAutoUpdateFromGitHub() {
  var localVersion = chrome.runtime.getManifest().version;

  return fetchRemoteVersion()
    .then(function(remoteVersion) {
      if (!remoteVersion) return false;

      return shouldSkipUpdateCheck(remoteVersion, localVersion).then(function(skip) {
        if (skip) return false;
        markUpdateCheckDone();
        return syncFromGitHubAndMaybeReload(localVersion, remoteVersion);
      });
    })
    .catch(function(err) {
      markUpdateCheckDone();
      if (typeof addLog === 'function') {
        addLog('Update check failed: ' + (err && err.message ? err.message : 'network error'));
      }
      return false;
    });
}