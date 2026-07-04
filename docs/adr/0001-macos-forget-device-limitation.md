# 0001. The macOS "Forget This Device" problem cannot be fixed from the browser

- Status: Accepted (2026-07-04)

## Context

With Web Bluetooth to the Mudra Link, once the connection drops, macOS keeps
holding the connection state, and reconnecting fails until the user manually
runs "Forget This Device". Reported for all exit paths: the Disconnect button,
closing the tab, and unexpected drops (out of range).

## Findings (root cause)

1. **`gatt.disconnect()` only drops the app (tab) level GATT reference, not the
   OS/device-level physical connection. This is intentional per spec.**
   - Chrome docs: disconnect "will NOT stop communication if another app is
     already communicating with the device." On macOS, CoreBluetooth is a shared
     OS service, so the OS itself acts as that "other app" and holds the link.
   - Web Bluetooth CG Issue #256 / Chromium bug #630586: the maintainers state
     connections are not closed when the OS needs them ("we can live with it").
     The spec is still "needs wording".
2. **The device bonds and uses a rotating BLE address** (Prodilink `ble.py`
   `find_bonded`). Clearing the bond / resolving the address is not controllable
   from the browser.
3. **The firmware has no disconnect/unbond command** (verified against the full
   `FirmwareCommand` enum in Prodilink `commands.py`). Ending the connection can
   only happen at the OS/BLE layer.
4. `forget()` only revokes the site's permission grant; it does not clear the OS
   bond.

→ "macOS stays connected" is **by design, not a bug**. No browser API exists to
drop the OS-level bond/connection.

## Decision

- From the browser, do only **best-effort graceful stop on the exit paths we can
  hook**:
  - Disconnect button: `DISABLE_SNC` + `gatt.disconnect()` (existing).
  - Tab close / reload: same via `pagehide` (added in `src/main.ts`).
  - Unexpected drop: the link is already gone, nothing can be sent → unfixable.
- For reconnect within a session, **reuse the retained `device` and reconnect
  via `gatt.connect()`** instead of `requestDevice()`. Verified: this fixes the
  post-drop reconnect without "Forget This Device".
- After a **page reload** the in-memory ref is gone, and because macOS still
  holds the link the band isn't advertising — so it doesn't appear in the
  chooser (`requestDevice()` → "Connection cancelled"). Fix: **`getDevices()`**
  returns the already-granted device without scanning, then `gatt.connect()`
  reuses the live OS connection. We never need the OS to actually disconnect.
  - **Hard limitation:** on desktop Chrome `getDevices()` is flag-gated. It
    requires BOTH `chrome://flags/#enable-experimental-web-platform-features`
    (exposes the method — otherwise `getDevices is not a function`) AND
    `chrome://flags/#enable-web-bluetooth-new-permissions-backend` (makes the
    permission persist so it returns the device). After enabling, re-grant the
    device once. Our code no-ops gracefully (`getDevices?.()`) when the method
    is absent, falling back to the chooser — which is empty for a non-advertising
    band, so **without the flags, reload recovery is impossible in the browser.**
    For flagless end-users the only recovery is power-cycling the band or
    "Forget This Device". A shippable fix requires the native path below.

  Match granted devices on the origin-scoped `device.id` (saved in
  localStorage), not `name` — `name` can be null for an OS-held device, and the
  band's BLE address rotates.
- **Vite HMR** reloads modules without a real teardown, leaving the link up
  across hot reloads (the main dev-time cause). `import.meta.hot.dispose()` can
  await, so it runs the full graceful stop before reload — added in `src/main.ts`.

Key insight: the browser cannot force macOS to drop the OS-level connection on
tab/app exit (no API exists). Instead of fighting that, we reconnect to the
still-open connection via retained `device` / `getDevices()`.

## Deliberately not done (add when a wall is actually hit)

- **Defensive re-attach on reconnect** (DISABLE→wait→startNotifications→ENABLE
  to reset a stale firmware/notify state) — reconnect works today; add if it
  proves flaky.
- **`forget()` reset button** — a UI escape hatch to revoke the grant and let
  CoreBluetooth drop the link when Chrome was the last holder. Add if users hit
  the chooser-dead-end.
- **Firmware force-disconnect opcode — investigated, see below.**
- **`watchAdvertisements()` reconnect** — does NOT work on macOS
  (`advertisementreceived` never fires). The `getDevices()` path is what avoids it.

## If a permanent fix is required

Move to a native path (the Prodilink approach: Python + bleak backend + a
WebSocket UI). That enables bond management, re-scanning, and auto-reconnect.
Not possible with the browser alone.

## Firmware disconnect opcode — investigation result

Goal: find a firmware command we could send on exit that makes the *device*
drop the link (which macOS releases cleanly, unlike a host-side disconnect).

Proven empirically (dev-only opcode probe, `writeValue` to CMD char `0xfff1`):

- **A device-initiated disconnect DOES make macOS release cleanly.** Sending
  `ff 01` (SHIPPING_MODE) disconnects and powers the band off; reconnect then
  reports "no longer in range" — i.e. the physical link is truly gone, not held.
  This confirms the whole approach direction.
- But `ff 01` powers the band off (needs a physical wake), so it's only usable
  as a deliberate "shut down the band" action, not automatic cleanup.
- Every other candidate just ACKs with no disconnect: `0a 01` (stop-advertising),
  `a0 00/01/02` (BandMode — only 0/1 valid; briefly stops SNC, keeps link),
  `43 00/01` (DeviceMode = HID target, unrelated). `01` = DFU (untested here).
- The full host-sendable command set (`getCommandBytes()` switch, 52 opcodes,
  fully extracted in Prodilink `re/firmware_commands.py`) contains **no
  soft-disconnect / disconnect-and-re-advertise opcode**. Only SHIPPING_MODE
  (power-off) disconnects device-side.

Conclusion: no graceful firmware disconnect exists in the host command set, so
this route can't provide automatic exit cleanup. The `.so` is host-side and
fully mined — finding a hidden soft-reboot command would require reversing the
**device firmware** (Nordic app image from a DFU `.zip`, Cortex-M) — large effort,
uncertain payoff. Not pursued.

Usable outcomes:
- **Manual "force release" button** via `ff 01` — turns the "Forget This Device"
  dance into one click (band powers off, macOS releases). Optional, not built.
- **DFU buttonless reboot** (write to DFU control point `8ec90003-…`) reboots the
  band; Nordic bootloader times out back to the app and re-advertises — a
  possible "reboot to recover" path, untested, medium risk.

## References

- https://developer.chrome.com/docs/capabilities/bluetooth
- https://github.com/WebBluetoothCG/web-bluetooth/issues/256
- Prodilink: `prodilink/ble.py`, `prodilink/commands.py`
