// GitHub auto-update helpers (imported by background.js)

const GITHUB_MANIFEST_URL =
  'https://raw.githubusercontent.com/SatnamSinghToor/SardarJi-Visa-Scheduler/main/manifest.json';
const NATIVE_HOST = 'com.sardarji.updater';
const UPDATE_CHECK_COOLDOWN_MS = 60 * 1000;

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

// Icon click: sync repo via native host; reload extension if files changed.
function tryAutoUpdateFromGitHub() {
  return shouldSkipUpdateCheck().then(function(skip) {
    if (skip) return false;

    var localVersion = chrome.runtime.getManifest().version;
    return fetchRemoteVersion()
      .then(function(remoteVersion) {
        markUpdateCheckDone();
        if (!remoteVersion) return false;

        var needsUpdate = compareVersion(remoteVersion, localVersion) > 0;
        return tryNativeGitHubSync().then(function(native) {
          if (native.ok) {
            var r = native.resp || {};
            if (r.success && (r.changed || needsUpdate)) {
              if (typeof addLog === 'function') {
                addLog('GitHub update applied' + (r.version ? ' (v' + r.version + ')' : '') + ' — reloading...');
              }
              setTimeout(function() { chrome.runtime.reload(); }, 400);
              return true;
            }
            if (r.success && !r.changed && typeof addLog === 'function') {
              addLog('Extension already up to date (v' + localVersion + ').');
            }
            return false;
          }

          if (needsUpdate && typeof addLog === 'function') {
            addLog('Update v' + remoteVersion + ' available. Run native-host/install once for auto-update.');
          }
          return false;
        });
      })
      .catch(function(err) {
        markUpdateCheckDone();
        if (typeof addLog === 'function') {
          addLog('Update check failed: ' + (err && err.message ? err.message : 'network error'));
        }
        return false;
      });
  });
}