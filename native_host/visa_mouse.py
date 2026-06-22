"""
SardarJi Native Host - Full OS-level automation for Chrome Extension
Commands: move, click, move_and_click, type, key, scroll, get_pos, ping
All actions use real Windows API (SetCursorPos, mouse_event, keybd_event).
"""
import sys
import json
import struct
import time
import random
import math
import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

# Mouse event flags
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800

# Keyboard event flags
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# Virtual key codes
VK = {
    'tab': 0x09, 'enter': 0x0D, 'return': 0x0D, 'shift': 0x10,
    'ctrl': 0x11, 'alt': 0x12, 'esc': 0x1B, 'escape': 0x1B,
    'space': 0x20, 'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
    'delete': 0x2E, 'backspace': 0x08, 'home': 0x24, 'end': 0x23,
    'pageup': 0x21, 'pagedown': 0x22,
    'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74,
    'f6': 0x75, 'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79,
    'f11': 0x7A, 'f12': 0x7B,
}


# ==================== MOUSE ====================

def get_screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def get_cursor_pos():
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def set_cursor_pos(x, y):
    user32.SetCursorPos(int(x), int(y))


def mouse_down():
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)


def mouse_up():
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


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
    user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, int(amount * 120), 0)


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

def key_press(vk_code):
    user32.keybd_event(vk_code, 0, 0, 0)
    time.sleep(0.02 + random.random() * 0.04)
    user32.keybd_event(vk_code, 0, KEYEVENTF_KEYUP, 0)


def key_combo(keys):
    """Press keys with modifiers held, e.g. ['ctrl', 'a']"""
    codes = [VK.get(k.lower(), 0) for k in keys]
    # Hold modifiers
    for c in codes[:-1]:
        if c:
            user32.keybd_event(c, 0, 0, 0)
    # Press final
    if codes[-1]:
        user32.keybd_event(codes[-1], 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(codes[-1], 0, KEYEVENTF_KEYUP, 0)
    # Release modifiers in reverse
    for c in reversed(codes[:-1]):
        if c:
            user32.keybd_event(c, 0, KEYEVENTF_KEYUP, 0)


def type_unicode_char(ch):
    """Type a single character using Unicode (works for all chars)."""
    code = ord(ch)
    user32.keybd_event(0, code, KEYEVENTF_UNICODE, 0)
    time.sleep(0.005)
    user32.keybd_event(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0)


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
                # Optional pre-move
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
                # Single key or combo: msg['key'] = 'enter' or msg['keys'] = ['ctrl','a']
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
