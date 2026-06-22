"""
SardarJi Native Host (macOS) - OS-level automation for Chrome Extension
Commands: move, click, move_and_click, mouse_down, mouse_up, type, key,
          scroll, get_pos, sleep, ping

macOS port of visa_mouse.py. Uses the Quartz / CoreGraphics event APIs instead
of the Windows user32 API, but speaks the exact same native-messaging protocol
and accepts the same commands, so the extension code does not change.

Requirements:
    pip3 install pyobjc-framework-Quartz

Permissions:
    The app that launches this host (Google Chrome) must be granted
    Accessibility permission:
        System Settings -> Privacy & Security -> Accessibility -> enable Chrome
    Otherwise mouse/keyboard events are silently ignored by macOS.
"""
import sys
import json
import struct
import time
import random
import math

import Quartz
from Quartz import (
    CGEventCreateMouseEvent,
    CGEventCreateScrollWheelEvent,
    CGEventCreateKeyboardEvent,
    CGEventKeyboardSetUnicodeString,
    CGEventPost,
    CGEventGetLocation,
    CGEventCreate,
    CGDisplayBounds,
    CGMainDisplayID,
    kCGEventMouseMoved,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGMouseButtonLeft,
    kCGScrollEventUnitLine,
    kCGHIDEventTap,
)

# Virtual key codes (macOS, ANSI layout) for non-character keys
VK = {
    'tab': 0x30, 'enter': 0x24, 'return': 0x24, 'shift': 0x38,
    'ctrl': 0x3B, 'alt': 0x3A, 'option': 0x3A, 'cmd': 0x37, 'command': 0x37,
    'esc': 0x35, 'escape': 0x35,
    'space': 0x31, 'left': 0x7B, 'up': 0x7E, 'right': 0x7C, 'down': 0x7D,
    'delete': 0x33, 'backspace': 0x33, 'home': 0x73, 'end': 0x77,
    'pageup': 0x74, 'pagedown': 0x79,
    'f1': 0x7A, 'f2': 0x78, 'f3': 0x63, 'f4': 0x76, 'f5': 0x60,
    'f6': 0x61, 'f7': 0x62, 'f8': 0x64, 'f9': 0x65, 'f10': 0x6D,
    'f11': 0x67, 'f12': 0x6F,
}


# ==================== MOUSE ====================

def get_screen_size():
    bounds = CGDisplayBounds(CGMainDisplayID())
    return int(bounds.size.width), int(bounds.size.height)


def get_cursor_pos():
    loc = CGEventGetLocation(CGEventCreate(None))
    return int(loc.x), int(loc.y)


def _post_mouse(event_type, x, y):
    evt = CGEventCreateMouseEvent(None, event_type, (x, y), kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, evt)


def set_cursor_pos(x, y):
    _post_mouse(kCGEventMouseMoved, int(x), int(y))


def mouse_down():
    x, y = get_cursor_pos()
    _post_mouse(kCGEventLeftMouseDown, x, y)


def mouse_up():
    x, y = get_cursor_pos()
    _post_mouse(kCGEventLeftMouseUp, x, y)


def mouse_click():
    # Vary every click so the pattern isn't identical each time:
    # a short hesitation before pressing, a varied press-hold, and an
    # occasional tiny double-settle.
    time.sleep(0.03 + random.random() * 0.12)
    mouse_down()
    time.sleep(0.05 + random.random() * 0.13)
    mouse_up()
    # ~12% of the time, a very slight extra pause as a human would after clicking
    if random.random() < 0.12:
        time.sleep(0.08 + random.random() * 0.15)


def scroll_wheel(amount):
    """Positive = scroll up, negative = scroll down. Amount in 'clicks'."""
    evt = CGEventCreateScrollWheelEvent(
        None, kCGScrollEventUnitLine, 1, int(amount))
    CGEventPost(kCGHIDEventTap, evt)


def human_move(target_x, target_y, duration_ms=None):
    """Bezier curve + ease in-out + jitter."""
    start_x, start_y = get_cursor_pos()
    dist = math.sqrt((target_x - start_x) ** 2 + (target_y - start_y) ** 2)

    if duration_ms is None:
        duration_ms = min(900, max(250, dist * 1.5)) + random.random() * 200

    cp_x = (start_x + target_x) / 2 + (random.random() - 0.5) * dist * 0.3
    cp_y = (start_y + target_y) / 2 + (random.random() - 0.5) * dist * 0.3

    start_time = time.perf_counter()
    end_time = start_time + duration_ms / 1000.0

    while True:
        now = time.perf_counter()
        if now >= end_time:
            break
        t = (now - start_time) / (duration_ms / 1000.0)
        if t > 1:
            t = 1
        ease = 2 * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 2) / 2

        x = (1 - ease) ** 2 * start_x + 2 * (1 - ease) * ease * cp_x + ease ** 2 * target_x
        y = (1 - ease) ** 2 * start_y + 2 * (1 - ease) * ease * cp_y + ease ** 2 * target_y

        if 0.05 < t < 0.95:
            x += (random.random() - 0.5) * 2
            y += (random.random() - 0.5) * 2

        set_cursor_pos(x, y)
        time.sleep(0.012)

    set_cursor_pos(target_x, target_y)


# ==================== KEYBOARD ====================

def _key_event(vk_code, down):
    evt = CGEventCreateKeyboardEvent(None, vk_code, down)
    CGEventPost(kCGHIDEventTap, evt)


def key_press(vk_code):
    _key_event(vk_code, True)
    time.sleep(0.02 + random.random() * 0.04)
    _key_event(vk_code, False)


def key_combo(keys):
    """Press keys with modifiers held, e.g. ['cmd', 'a']"""
    codes = [VK.get(k.lower(), None) for k in keys]
    # Hold modifiers
    for c in codes[:-1]:
        if c is not None:
            _key_event(c, True)
    # Press final
    if codes[-1] is not None:
        _key_event(codes[-1], True)
        time.sleep(0.05)
        _key_event(codes[-1], False)
    # Release modifiers in reverse
    for c in reversed(codes[:-1]):
        if c is not None:
            _key_event(c, False)


def type_unicode_char(ch):
    """Type a single character using a Unicode keyboard event (any char)."""
    down = CGEventCreateKeyboardEvent(None, 0, True)
    CGEventKeyboardSetUnicodeString(down, len(ch), ch)
    CGEventPost(kCGHIDEventTap, down)
    time.sleep(0.005)
    up = CGEventCreateKeyboardEvent(None, 0, False)
    CGEventKeyboardSetUnicodeString(up, len(ch), ch)
    CGEventPost(kCGHIDEventTap, up)


def human_type(text):
    """Type text with realistic per-character delays."""
    for ch in text:
        if ch == '\n':
            key_press(VK['enter'])
        elif ch == '\t':
            key_press(VK['tab'])
        else:
            type_unicode_char(ch)

        # Very fast typing with a touch of variation (so it isn't perfectly
        # robotic, but still quick).
        base = 0.012 + random.random() * 0.028
        if ch in "@.-_!#$%":
            base += 0.015 + random.random() * 0.03
        if ch.isdigit():
            base += 0.008 + random.random() * 0.015
        if random.random() < 0.08:
            base += 0.05 + random.random() * 0.08
        time.sleep(base)


# ==================== NATIVE MESSAGING I/O ====================

def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) == 0:
        return None
    msg_len = struct.unpack('I', raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len).decode('utf-8')
    return json.loads(raw_msg)


# ==================== COMMAND DISPATCHER ====================

def main():
    send_message({'type': 'ready', 'screen': get_screen_size()})

    while True:
        try:
            msg = read_message()
            if msg is None:
                break

            cmd = msg.get('cmd')

            if cmd == 'ping':
                send_message({'ok': True, 'pong': True})

            elif cmd == 'move':
                human_move(msg['x'], msg['y'], msg.get('duration'))
                send_message({'ok': True})

            elif cmd == 'click':
                if 'x' in msg and 'y' in msg:
                    human_move(msg['x'], msg['y'])
                    time.sleep(0.08 + random.random() * 0.12)
                mouse_click()
                send_message({'ok': True})

            elif cmd == 'move_and_click':
                human_move(msg['x'], msg['y'])
                time.sleep(0.08 + random.random() * 0.12)
                mouse_click()
                send_message({'ok': True})

            elif cmd == 'mouse_down':
                mouse_down()
                send_message({'ok': True})

            elif cmd == 'mouse_up':
                mouse_up()
                send_message({'ok': True})

            elif cmd == 'type':
                human_type(msg['text'])
                send_message({'ok': True})

            elif cmd == 'key':
                if 'keys' in msg:
                    key_combo(msg['keys'])
                else:
                    k = msg.get('key', '').lower()
                    if k in VK:
                        key_press(VK[k])
                    else:
                        send_message({'ok': False, 'error': f'unknown_key: {k}'})
                        continue
                send_message({'ok': True})

            elif cmd == 'scroll':
                scroll_wheel(msg.get('amount', -3))
                send_message({'ok': True})

            elif cmd == 'get_pos':
                x, y = get_cursor_pos()
                send_message({'ok': True, 'x': x, 'y': y})

            elif cmd == 'sleep':
                time.sleep(msg.get('seconds', 1))
                send_message({'ok': True})

            else:
                send_message({'ok': False, 'error': 'unknown_cmd: ' + str(cmd)})

        except Exception as e:
            try:
                send_message({'ok': False, 'error': str(e)})
            except Exception:
                break


if __name__ == '__main__':
    main()
