# Function Reference — SardarJi Appointment Scheduler

A complete A–Z list of every function in the project, grouped by file, with a
one-line description of what each does.

---

## `background.js` — service worker (the brain)

| Function | What it does |
|----------|--------------|
| `actuallySendLogin` | Sends the `DO_LOGIN` command to the page; retries if the content script isn't ready yet. |
| `addLog` | Appends a timestamped line to the Activity Log (writes are serialized so lines are never lost). |
| `beginMonitoringLoop` | Starts the slot-checking loop (schedules the first check). |
| `clearVisaSiteData` | Clears the visa site's cookies, cache and storage (with a safety timeout). |
| `doKeepAlive` | Sends a lightweight request to keep the session alive between checks. |
| `ensureScheduleAndMonitor` | Finds the schedule ID, then begins the monitoring loop. |
| `handleBookingResult` | Handles a booking outcome — notifies and stops monitoring on success, resumes monitoring on failure. |
| `handleCheckComplete` | Processes a finished check: stats, session-expiry → re-login, rate-limit backoff, reschedule. |
| `handleLoginFailed` | Decides **stop** (wrong credentials / captcha) vs **retry** (timeout / transient), capped at `MAX_TRANSIENT_RETRIES`. |
| `handleLoginSuccess` | Marks login successful, resets flags, resumes monitoring. |
| `handlePageReady` | Central router for every page load (login / groups / continue-actions / appointment / logged-in / unknown). |
| `handleSlotFound` | Fires the slot alert (deduped to once/hour per date+facility) — desktop notification + Telegram + sound. |
| `isInActiveWindow` | Returns whether the current time/day is inside the configured active hours (schedule). |
| `notifyDesktop` | Creates a desktop notification only if enabled in settings. |
| `openCleanLoginPage` | Icon-click entry point: blank tab → clear cookies/data → open the login page, then wait for START. |
| `openFreshLoginSession` | Opens a clean tab, clears site data, and starts a fresh login (used on session expiry / retry). |
| `playSound` | Plays the alert tone via the offscreen document (only if sound is enabled). |
| `restoreIfActive` | Resumes monitoring after a Chrome / service-worker restart. |
| `scheduleNext` | Schedules the next check at a randomized interval; adds a keep-alive ping for long gaps. |
| `sendLoginWithRetry` | Orchestrates login — guards against duplicate triggers, then sends the login command. |
| `sendTelegram` | Sends a Telegram message (only if a token + chat ID are configured). |
| `startMonitoring` | Starts monitoring with the given config and resets all state. |
| `stopMonitoring` | Stops monitoring, clears all alarms/flags, and tells any open visa tab to abort in-progress login/booking. |
| `triggerCheck` | Runs one cycle: active-hours gate → check page state → run a slot check or re-login. |

*Internal helpers:* `inWindow`, `parseTime` (time-window math inside `isInActiveWindow`), `runInTab` (inline helper inside `openCleanLoginPage`/`openFreshLoginSession`).

> ⚠️ Note: this file previously described native-mouse functions
> (`connectNative`, `sendNativeMouse`, `findOrCreateVisaTab`, `closeOldVisaTabs`,
> `checkLoginAndProceed`) that no longer exist — the native messaging host was
> removed from the project. This section now reflects the current code.

---

## `content.js` — runs on `ais.usvisa-info.com` (the hands)

### Page detection & flow
| Function | What it does |
|----------|--------------|
| `detectPage` | Identifies the current page (login / groups / continue-actions / appointment / logged-in / unknown). |
| `detectCaptcha` | Detects a reCAPTCHA / hCaptcha on the page. |
| `getLoginError` | Reads the website's login error text (e.g. "Invalid email or password"). |
| `getCSRF` | Reads the page's CSRF token for API requests. |
| `keepSessionAlive` | Sends a quiet same-origin request to refresh the session timer; returns whether still logged in. |

### Login
| Function | What it does |
|----------|--------------|
| `doLogin` | Full auto-login: type email/password, tick the policy box, submit, then classify success/failure. |
| `ensurePolicyChecked` | Ticks the privacy/policy checkbox using several reliable methods (native setter, iCheck events, click fallback). |
| `dismissBlockingModal` | Closes any blocking modal/popup that's in the way. |

### Slot checking & booking
| Function | What it does |
|----------|--------------|
| `checkSlots` | Fetches available days per facility, filters by date range, **verifies real bookable times**, alerts/books. |
| `getTimesForDate` | Fetches the actual bookable times for a date (confirms a slot is real, not a phantom). |
| `startBooking` | Begins booking a found slot (fetch times → save booking state → navigate to the booking form). |
| `handleBookingContinuation` | Resumes an in-progress booking across page navigations, based on saved `bookingState.step`. |
| `abortBooking` | Abandons the current booking (e.g. slot taken) and reports failure so monitoring resumes. |
| `fillBookingForm` | Fills facility / date / time on the booking form and submits. |
| `clickConfirm` | Clicks the final "Confirm" button to lock in the appointment. |
| `pageIndicatesBooked` | Positive-signal check ("has been scheduled", "confirmation number", ...) used to avoid false failure reports. |
| `finalizeBooking` | Verifies the booking result on whatever page it lands on and reports it exactly once. |
| `findScheduleOnPage` | Searches the page for the schedule ID (answers `FIND_SCHEDULE`). |
| `goToSchedulePage` | Navigates to the schedule page (answers `GO_TO_SCHEDULE`). |
| `findScheduleId` | Gets the schedule ID from config, URL, or page links. |
| `clickScheduleAppointment` | Clicks "Schedule Appointment" on the continue-actions page. |
| `clickContinueOnGroupsPage` | Clicks "Continue" on the Groups page. |

### Calendar
| Function | What it does |
|----------|--------------|
| `navigateToMonth` | Moves the datepicker to the target month/year. |
| `panelMatches` | Checks whether a datepicker panel is showing the given year/month. |
| `availableDaysIn` | Lists the clickable (available) day numbers in a datepicker panel. |
| `logCalendarDates` | Logs the calendar's open days for a month — a cross-check against the JSON API response. |
| `clickDay` | Clicks a specific day — scoped to the correct month panel (avoids wrong-month bookings). |

### Human-like input (synthetic mouse/keyboard)
| Function | What it does |
|----------|--------------|
| `initCursor` / `resetCursor` | Initialize / reset the virtual cursor state. |
| `moveCursorTo` | Moves the synthetic cursor to an element (dispatches mouseenter/over/move). |
| `clickAtCursor` | Dispatches synthetic mousedown/mouseup/click events at the cursor position. |
| `macroClick` | Human-like click: move cursor, pause, click. |
| `macroFocusAndType` | Click a field, then type into it. |
| `macroScrollToAndFocus` | Scrolls an element into view and moves the cursor to it. |
| `osScroll` | Scrolls the page smoothly (used by booking-form navigation). |
| `typeHuman` | Types text with realistic per-character timing via synthetic key/input events. |
| `forceInputValue` | Forces an input's value via the native setter (framework-safe) and verifies it stuck. |
| `viewportToScreen` | Converts in-page coordinates to physical screen coordinates (kept for a currently-disabled native-mouse path). |
| `nativeCall` | Sends a `NATIVE_MOUSE` command to the background (currently unused — see note below). |

> ⚠️ Real OS mouse/keyboard control (`useNativeMouse` / `useNativeKeyboard`) is
> **disabled by design** — see the comment above these flags in `content.js`.
> `macroPressEnter`, `macroPressTab`, `macroScrollDown`, `macroScrollUp`, and
> `pressKey` are dead code left over from when native input was active; they
> are not called anywhere in the current flow.

### Utilities
| Function | What it does |
|----------|--------------|
| `done` | Sends `CHECK_COMPLETE` back to the background. |
| `log` | Sends a log line to the background. |
| `delay` | Abort-aware promise-based sleep (ends early if STOP was pressed). |
| `waitForEl` | Waits for an element to appear via `MutationObserver` (with timeout). |
| `waitForLoginResult` | Waits until login resolves: navigation away from `/sign_in`, an inline error, or a captcha. |

> ⚠️ `waitForNavigation` is defined but never called anywhere in the current
> code — dead code left over from an earlier flow.

---

## `popup.js` — toolbar popup UI

> ⚠️ `manifest.json` has no `default_popup`, and the icon-click handler in
> `background.js` opens the **side panel** instead. This file is currently
> **unreachable** through normal extension use — see `TODO.md`.

| Function | What it does |
|----------|--------------|
| `init` | Wires up the popup and loads saved settings. |
| `updateUI` | Switches the UI between idle / monitoring states. |
| `updateStats` | Refreshes the checks / found / last-check counters. |
| `updateLog` | Renders the activity log. |

---

## `sidebar.js` — side-panel UI (the one actually shown to users)

| Function | What it does |
|----------|--------------|
| `init` | Boots the sidebar: wires all controls, loads data, starts auto-refresh. |
| `$` / `$$` | Shorthand for `document.getElementById` / `document.querySelectorAll`. |
| `wireBookingCelebration` | Wires the celebration banner's close button and listens for a live `BOOKING_CONFIRMED` push. |
| `showBookingCelebration` | Fills in and shows the "Congratulations! Slot Booked" banner. |
| `maybeShowBookingCelebration` | Shows the celebration banner on load only if the last booking was recent (avoids surfacing a stale one). |
| `wireIntervalHints` | Live "= X min" hint next to the interval (seconds) inputs. |
| `wireAdvancedToggle` | Expands/collapses the Advanced Settings section. |
| `wireConditionalFields` | Shows/hides dependent fields (schedule windows, Telegram fields). |
| `wirePasswordToggle` | Show/hide password. |
| `wireTestTelegram` | Sends a Telegram test message. |
| `wireSaveAdvanced` | Saves advanced settings (schedule, telegram, notifications, facilities). |
| `wireCopyLog` | Copies the activity log to the clipboard. |
| `wireStartButton` / `wireStopButton` | Hook up Start / Stop, validating inputs first. |
| `setDateDefaults` | Pre-fills the date range fields (today → +90 days) if empty. |
| `loadSavedData` | Loads saved credentials/config/settings into the form on open. |
| `updateStatus` | Updates the status badge (Idle / Monitoring). |
| `updateStats` | Refreshes the checks / found / last-check counters. |
| `updateLog` | Renders the activity log; preserves scroll position and shows a "jump to latest" button if scrolled up. |
| `wireJumpToBottom` | Wires the "↓ New logs" button to jump to the latest log entry. |
| `startAutoRefresh` | Periodically (every 3s) refreshes status, stats, log, and checks for a new booking. |

---

## `options.js` — settings page

| Function | What it does |
|----------|--------------|
| `getSelectedFacilities` | Reads the ticked multi-facility checkboxes. |
| `setSelectedFacilities` | Ticks the checkboxes from saved config. |

*(The save/load and Telegram-test logic runs inline in the `DOMContentLoaded` handler.)*

---

## `build.js` — obfuscation/packaging script

Minifies `background.js`, `content.js`, `popup.js`, `sidebar.js`, `options.js`,
`offscreen.js` with Terser and copies the rest (`manifest.json`, HTML/CSS,
`icons/`) into `../sardarji-dist`.
