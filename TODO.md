# TODO — Codebase Audit Findings

Full file-by-file, function-by-function review of the extension (2026-07-02).
Items are ordered roughly by severity/impact. None of these have been fixed
yet — this is a punch list to work through.

---

## 🔴 Critical

1. **`build.js` never ships the side panel — the packaged extension is broken.**
   `jsFiles`, `copyFiles`, and `copyDirs` in `build.js` list `popup.js`,
   `popup.html`, `popup.css`, `options.*`, `offscreen.html`, `icons/` — but
   **not** `sidebar.js`, `sidebar.html`, or `sidebar.css`. `manifest.json`'s
   `side_panel.default_path` is `sidebar.html`, and the side panel is the
   *only reachable UI* (see #2). Running `node build.js` / `npm run build`
   produces a `dist` folder where clicking the extension icon opens a side
   panel that 404s. Anyone testing from the built/obfuscated package (e.g.
   before a Web Store submission) would hit this immediately.
   → Fix: add `'sidebar.js'` to `jsFiles` and `'sidebar.html'`, `'sidebar.css'`
   to `copyFiles` in `build.js`.

## 🟠 Dead code

2. **`popup.html` / `popup.js` / `popup.css` are unreachable in normal use.**
   `manifest.json`'s `action` has no `default_popup`, and `background.js`'s
   `chrome.action.onClicked` listener opens the **side panel** instead
   (`sidebar.html`). Chrome only fires `onClicked` when there's no popup set,
   so this *is* consistent — but it means these three files (~1000 lines
   combined) are a near-complete, silently-drifting duplicate of
   `sidebar.*` that no user ever sees.
   → Decide: either wire up a real way to reach the popup (e.g. set it as
   `default_popup` and drop the side-panel-only flow), or delete
   `popup.html`/`popup.js`/`popup.css` entirely and stop maintaining two
   copies of the same UI.

3. **`content.js` — several functions are defined but never called:**
   - `waitForNavigation` (line ~1417) — no call sites anywhere.
   - `macroPressEnter`, `macroPressTab`, `macroScrollDown`, `macroScrollUp`,
     `pressKey` — leftover from when native OS keyboard control
     (`useNativeKeyboard`) was enabled; that flag is now hard-coded `false`
     (see the comment above it) and nothing calls these anymore.
   → Either remove them, or add a one-line comment marking them as
   intentionally-kept/reserved if there's a reason to keep them.

## 🟡 Duplication (same logic, multiple places — bugs get fixed in one copy and not the others)

4. **`background.js`: `openCleanLoginPage()` and `openFreshLoginSession()`**
   do almost identical work (get/reuse a visa tab → blank it → clear cookies
   & storage → load the login URL) with slightly different state flags and
   no shared helper. Worth extracting the common "clear + open login tab"
   logic into one function both call.

5. **`popup.js` vs `sidebar.js`** — ~90% identical (save/load settings,
   start/stop validation, stats/log rendering, password toggle, Telegram
   test). Given #2, if popup is kept, this duplication should be resolved by
   sharing one module; if popup is deleted, this resolves itself.

6. **The facility list and settings form are copy-pasted across three
   places**: `popup.html`+`popup.js`, `sidebar.html`+`sidebar.js`, and
   `options.html`+`options.js` all hard-code the same
   `{89: Calgary, 90: Halifax, ...}` map and near-identical form markup
   (schedule windows, Telegram fields, notification toggles). Adding or
   renaming a facility currently means editing up to 6 files by hand.

7. **Telegram "test" message text has already drifted** between the
   duplicated copies: `popup.js` sends *"SardarJi Appointment Scheduler
   connected!"*, `sidebar.js` sends *"SardarJi Scheduler connected!"* —
   harmless, but a live example of #5's maintenance risk.

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

9. **`README.md`'s Files table lists `popup.*` as "Toolbar popup UI"**
   without noting it's currently unreachable (#2). Once #2 is resolved one
   way or the other, update the table accordingly.

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
    they arrive reversed, but both `sidebar.js` and `popup.js` already
    enforce `intervalMax >= intervalMin` before saving — so that swap path
    is effectively unreachable via the UI today. Harmless belt-and-suspenders.
