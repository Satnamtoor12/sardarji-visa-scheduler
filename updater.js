// GitHub auto-update helpers (imported by background.js)
// Sidebar open only (not during monitoring). Reload only when git changes files.

const GITHUB_REPO = 'SatnamSinghToor/SardarJi-Visa-Scheduler';
const GITHUB_MANIFEST_URL =
  'https://raw.githubusercontent.com/' + GITHUB_REPO + '/main/manifest.json';
const NATIVE_HOST = 'com.sardarji.updater';
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
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, function(resp) {
        resolve(!chrome.runtime.lastError && resp && resp.success);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function tryNativeGitHubSync() {
  return new Promise(function(resolve) {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'update' }, function(resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, resp: resp || {} });
      });
    } catch (e) {
      resolve({ ok: false, reason: e && e.message ? e.message : 'native error' });
    }
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
  return tryNativePing().then(function(ready) {
    if (!ready) return false;
    return tryNativeGitHubSync().then(function(native) {
      if (!native.ok || !native.resp || !native.resp.success) return false;

      var r = native.resp;
      if (!r.changed) return false;

      var newVer = r.version || localVersion;
      if (typeof addLog === 'function') {
        addLog('GitHub sync complete (v' + newVer + ').');
      }
      return forceExtensionReload('Updated to v' + newVer + ' — reloading...', newVer);
    });
  });
}

// Sidebar open only — skip while monitoring is active.
function trySidebarUpdateCheck() {
  return new Promise(function(resolve) {
    try {
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
          .catch(function() { resolve(false); });
      });
    } catch (e) {
      resolve(false);
    }
  });
}