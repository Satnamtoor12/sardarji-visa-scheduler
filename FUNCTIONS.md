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
| `checkLoginAndProceed` | Asks the page what state it's in, then logs in or proceeds to monitoring. |
| `clearVisaSiteData` | Clears the visa site's cookies, cache and storage (with a safety timeout). |
| `closeOldVisaTabs` | Closes leftover visa tabs except the current fresh-login tab. |
| `connectNative` | Connects to the native messaging host (real mouse/keyboard). |
| `doKeepAlive` | Sends a lightweight request to keep the session alive between checks. |
| `ensureScheduleAndMonitor` | Finds the schedule ID, then begins the monitoring loop. |
| `findOrCreateVisaTab` | Reuses an existing visa tab or opens a new one. |
| `handleBookingResult` | Handles a booking outcome — notifies and stops monitoring on success. |
| `handleCheckComplete` | Processes a finished check: stats, session-expiry → re-login, rate-limit backoff, reschedule. |
| `handleLoginFailed` | Decides **stop** (wrong credentials / captcha) vs **retry** (timeout / transient), capped. |
| `handleLoginSuccess` | Marks login successful, resets flags, resumes monitoring. |
| `handlePageReady` | Central router for every page load (login / groups / appointment / logged-in / unknown). |
| `handleSlotFound` | Fires the slot alert (deduped to once/hour) — desktop notification + Telegram + sound. |
| `isInActiveWindow` | Returns whether the current time/day is inside the configured active hours. |
| `notifyDesktop` | Creates a desktop notification only if enabled in settings. |
| `openFreshLoginSession` | Opens a clean tab, clears site data, and starts a fresh login (used on session expiry). |
| `playSound` | Plays the alert tone via the offscreen document (only if sound is enabled). |
| `restoreIfActive` | Resumes monitoring after a Chrome / service-worker restart. |
| `scheduleNext` | Schedules the next check at a randomized interval; adds a keep-alive ping for long gaps. |
| `sendLoginWithRetry` | Orchestrates login — clears the session if needed, then sends the login command. |
| `sendNativeMouse` | Sends a command to the native host and returns its response. |
| `sendTelegram` | Sends a Telegram message (only if a token + chat ID are configured). |
| `startMonitoring` | Starts monitoring with the given config and resets all state. |
| `stopMonitoring` | Stops monitoring and clears all alarms/flags. |
| `triggerCheck` | Runs one cycle: active-hours gate → check page state → run a slot check or re-login. |

*Internal helpers:* `inWindow`, `parseTime` (time-window math inside `isInActiveWindow`), and inline tab-load `listener`s.

---

## `content.js` — runs on `ais.usvisa-info.com` (the hands)

### Page detection & flow
| Function | What it does |
|----------|--------------|
| `detectPage` | Identifies the current page (login / groups / continue-actions / appointment / logged-in). |
| `detectCaptcha` | Detects a reCAPTCHA / hCaptcha on the page. |
| `getLoginError` | Reads the website's login error text (e.g. "Invalid email or password"). |
| `getCSRF` | Reads the page's CSRF token for API requests. |
| `keepSessionAlive` | Sends a quiet same-origin request to refresh the session timer. |

### Login
| Function | What it does |
|----------|--------------|
| `doLogin` | Full auto-login: type email/password, tick the policy box, submit, then classify success/failure. |
| `ensurePolicyChecked` | Ticks the privacy/policy checkbox using several reliable methods. |
| `dismissBlockingModal` | Closes any blocking modal/popup that's in the way. |

### Slot checking & booking
| Function | What it does |
|----------|--------------|
| `checkSlots` | Fetches available days, filters by date range, **verifies real bookable times**, alerts/books. |
| `getTimesForDate` | Fetches the actual bookable times for a date (confirms a slot is real, not a phantom). |
| `startBooking` | Begins booking a found slot (fetch times → navigate to the booking form). |
| `handleBookingContinuation` | Resumes an in-progress booking across page navigations. |
| `fillBookingForm` | Fills facility / date / time on the booking form and submits. |
| `clickConfirm` | Clicks the final "Confirm" button to lock in the appointment. |
| `findScheduleId` | Gets the schedule ID from config, URL or page links. |
| `findScheduleOnPage` | Searches the page for the schedule ID (answers `FIND_SCHEDULE`). |
| `goToSchedulePage` | Navigates to the schedule page. |
| `clickScheduleAppointment` | Clicks "Schedule Appointment" on the continue-actions page. |
| `clickContinueOnGroupsPage` | Clicks "Continue" on the Groups page. |

### Calendar
| Function | What it does |
|----------|--------------|
| `navigateToMonth` | Moves the datepicker to the target month/year. |
| `clickDay` | Clicks a specific day — scoped to the correct month panel (avoids wrong-month bookings). |

### Human-like input (mouse/keyboard)
| Function | What it does |
|----------|--------------|
| `initCursor` / `resetCursor` | Initialize / reset the virtual cursor state. |
| `moveCursorTo` | Moves the real (native) or synthetic cursor to an element. |
| `clickAtCursor` | Real OS click (native host) plus synthetic mouse events. |
| `macroClick` | Human-like click: move cursor, pause, click. |
| `macroFocusAndType` | Click a field, then type into it. |
| `typeHuman` | Types text with realistic per-character timing (native or synthetic). |
| `forceInputValue` | Forces an input's value in a framework-safe way and verifies it. |
| `macroScrollToAndFocus` | Scrolls an element into view and moves the cursor to it. |
| `macroScrollDown` / `macroScrollUp` / `osScroll` | Scroll the page (native wheel or synthetic). |
| `macroPressEnter` / `macroPressTab` / `pressKey` | Press keys via the native host. |
| `nativeCall` | Sends a `NATIVE_MOUSE` command to the background → native host. |
| `viewportToScreen` | Converts in-page coordinates to whole-screen coordinates. |

### Utilities
| Function | What it does |
|----------|--------------|
| `done` | Sends `CHECK_COMPLETE` back to the background. |
| `log` | Sends a log line to the background. |
| `delay` | Promise-based sleep. |
| `waitForEl` | Waits for an element to appear (with timeout). |
| `waitForNavigation` | Waits for the page to navigate/load (with timeout). |

---

## `popup.js` — toolbar popup UI

| Function | What it does |
|----------|--------------|
| `init` | Wires up the popup and loads saved settings. |
| `updateUI` | Switches the UI between idle / monitoring states. |
| `updateStats` | Refreshes the checks / found / last-check counters. |
| `updateLog` | Renders the activity log. |

---

## `sidebar.js` — side-panel UI

| Function | What it does |
|----------|--------------|
| `init` | Boots the sidebar: wires controls, loads data, starts auto-refresh. |
| `loadSavedData` | Loads saved credentials/config/settings into the form. |
| `setDateDefaults` | Pre-fills the date range fields. |
| `startAutoRefresh` | Periodically refreshes status, stats and log. |
| `updateStatus` | Updates the status badge (Idle / Monitoring). |
| `updateStats` | Refreshes the counters. |
| `updateLog` | Renders the activity log. |
| `wireStartButton` / `wireStopButton` | Hook up Start / Stop. |
| `wireSaveAdvanced` | Saves advanced settings. |
| `wireAdvancedToggle` | Expands/collapses the advanced section. |
| `wireConditionalFields` | Shows/hides dependent fields (e.g. Telegram). |
| `wirePasswordToggle` | Show/hide password. |
| `wireCopyLog` | Copies the activity log. |
| `wireTestTelegram` | Sends a Telegram test message. |

---

## `options.js` — settings page

| Function | What it does |
|----------|--------------|
| `getSelectedFacilities` | Reads the ticked multi-facility checkboxes. |
| `setSelectedFacilities` | Ticks the checkboxes from saved config. |

*(The save/load and Telegram-test logic runs inline in the `DOMContentLoaded` handler.)*

---

## `native_host/visa_mouse.py` (Windows) & `visa_mouse_mac.py` (macOS)

Real OS-level mouse/keyboard control. Identical command protocol; Windows uses
the `user32` API, macOS uses Quartz/CoreGraphics.

| Function | What it does |
|----------|--------------|
| `get_screen_size` | Returns the screen width/height. |
| `get_cursor_pos` / `set_cursor_pos` | Read / move the real OS cursor. |
| `mouse_down` / `mouse_up` / `mouse_click` | Real mouse button press / release / click. |
| `scroll_wheel` | Real mouse-wheel scroll. |
| `human_move` | Moves the cursor along a human-like Bézier curve with jitter. |
| `key_press` / `key_combo` | Press a key / a key combination (e.g. Ctrl+A). |
| `type_unicode_char` / `human_type` | Type characters with human-like per-key timing. |
| `send_message` / `read_message` | Native-messaging protocol I/O (length-prefixed JSON). |
| `main` | Command dispatcher loop (move / click / type / key / scroll / ping …). |

*macOS-only internal helpers:* `_post_mouse`, `_key_event` (Quartz event wrappers).
