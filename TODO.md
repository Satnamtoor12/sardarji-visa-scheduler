# TODO — Codebase Audit Findings

Full file-by-file, function-by-function review of the extension (2026-07-02).
Items are ordered roughly by severity/impact. None of these have been fixed
yet — this is a punch list to work through.

---

## 🔴 Critical

1. ~~**`build.js` never ships the side panel — the packaged extension is broken.**~~
   **FIXED.** `jsFiles`/`copyFiles` in `build.js` were missing `sidebar.js`,
   `sidebar.html`, `sidebar.css` even though the side panel is the only
   reachable UI (see #2). `node build.js` now correctly obfuscates/copies
   them into `dist`; verified with a real build run.

1b. ~~**`offscreen.html` used an inline `<script>` tag, which the extension's
   Content Security Policy (`script-src 'self'`) blocks.**~~ **FIXED.**
   Chrome's own extension console showed: *"Executing inline script violates
   ... The action has been blocked."* — meaning `playAlert()` never actually
   ran, so **the alert sound silently never played**, in both the source and
   any packaged build. Moved the script out to `offscreen.js` (loaded via
   `<script src="offscreen.js">`), which CSP allows, and added it to
   `build.js`'s `jsFiles` so it ships obfuscated like the other scripts.

## 🟠 Dead code

2. ~~**`popup.html` / `popup.js` / `popup.css` are unreachable in normal use.**~~
   **REMOVED.** Deleted the duplicate popup UI (~1000 lines). Shared form
   styles kept as `options-base.css` for the settings page.

3. ~~**`content.js` — several functions are defined but never called**~~
   **REMOVED.** Deleted `waitForNavigation`, `macroPressEnter`, `macroPressTab`,
   `macroScrollDown`, `macroScrollUp`, `pressKey`, `osScroll`, and the entire
   disabled native OS mouse/keyboard path (`nativeCall`, `viewportToScreen`,
   `useNativeMouse`, `useNativeKeyboard`).

## 🟡 Duplication (same logic, multiple places — bugs get fixed in one copy and not the others)

4. **`background.js`: `openCleanLoginPage()` and `openFreshLoginSession()`**
   do almost identical work (get/reuse a visa tab → blank it → clear cookies
   & storage → load the login URL) with slightly different state flags and
   no shared helper. Worth extracting the common "clear + open login tab"
   logic into one function both call.

5. ~~**`popup.js` vs `sidebar.js`**~~ **RESOLVED** by deleting `popup.js`.

6. **The facility list and settings form are copy-pasted across two
   places**: `sidebar.html`+`sidebar.js` and `options.html`+`options.js`
   both hard-code the same `{89: Calgary, 90: Halifax, ...}` map and
   near-identical form markup (schedule windows, Telegram fields,
   notification toggles). Adding or renaming a facility currently means
   editing up to 4 files by hand.

7. ~~**Telegram "test" message text drifted between popup and sidebar**~~
   **RESOLVED** by deleting `popup.js`.

## 🟢 Documentation

8. **`FUNCTIONS.md` was significantly stale** (fixed in this pass) — it
   documented `native_host/visa_mouse.py` / `visa_mouse_mac.py` and
   functions like `connectNative`, `sendNativeMouse`, `findOrCreateVisaTab`,
   `closeOldVisaTabs`, `checkLoginAndProceed` that no longer exist (the
   native messaging host was removed in an earlier commit). It was also
   missing newer functions (`abortBooking`, `finalizeBooking`,
   `pageIndicatesBooked`, `panelMatches`, `availableDaysIn`,
   `logCalendarDates`, the booking-celebration/jump-to-bottom helpers in
   `sidebar.js`). Now regenerated to match the current code — keep it in
   sync going forward, or consider generating it from source comments
   instead of hand-maintaining it.

9. ~~**`README.md`'s Files table lists `popup.*`**~~ **FIXED** — table updated
   after popup removal.

## ⚪ Permissions / minor

10. **`manifest.json` requests `"activeTab"`** alongside `"tabs"` and full
    `host_permissions` for `ais.usvisa-info.com`. Given the extension
    already has persistent host access and the `tabs` permission, double
    check whether `activeTab` is actually doing anything — if not, dropping
    it slightly narrows the permission prompt users see on install.

## 🧪 Testing (still true, and still unaddressed — see previous audit)

11. **Zero automated tests, no CI.** The highest-risk, currently-untested
    logic:
    - `content.js` `checkSlots` — date-range filtering that decides which
      slots the user gets alerted/booked for.
    - `background.js` `handleLoginFailed` — fatal-vs-retry classification
      (a wrong call here risks an account/IP block per the README's own
      warning).
    - `background.js` `isInActiveWindow` / `parseTime` / `inWindow` —
      active-hours math, including midnight-wrap.
    - `content.js` `detectPage` — routes every downstream action; a
      misclassification silently breaks the whole flow.
    - `content.js` `panelMatches` / `clickDay` — calendar month/day
      scoping; the existing comment ("avoids wrong-month bookings")
      suggests this was a past bug source.
    A prior session added Jest unit tests + fixtures for exactly these
    functions (by extracting them into a `lib/` folder) and a CI workflow;
    that work was explicitly reverted at the user's request, but the
    extraction pattern it used is still a reasonable template to redo this
    from, if/when wanted.

## Not a bug, just noting for future maintainers

12. `content.js`'s date-range filter (`d >= config.dateFrom && d <= config.dateTo`)
    is a plain string comparison — correct only because dates are always
    `YYYY-MM-DD`, where lexicographic order equals chronological order.
13. `scheduleNext()` in `background.js` swaps `intervalMin`/`intervalMax` if
    they arrive reversed, but `sidebar.js` already enforces
    `intervalMax >= intervalMin` before saving — so that swap path is
    effectively unreachable via the UI today. Harmless belt-and-suspenders.
