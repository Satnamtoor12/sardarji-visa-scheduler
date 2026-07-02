#!/usr/bin/env python3
"""SardarJi native messaging host — git sync from GitHub (macOS / Linux)."""

import json
import os
import struct
import subprocess
import sys


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    if msg_len <= 0 or msg_len > 1048576:
        return None
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode('utf-8'))


def write_message(obj):
    encoded = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git_output(args, cwd):
    try:
        return subprocess.check_output(
            ['git'] + args,
            cwd=cwd,
            stderr=subprocess.DEVNULL
        ).decode('utf-8').strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ''


def run_git(args, cwd):
    try:
        subprocess.run(
            ['git'] + args,
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False
        )
    except FileNotFoundError:
        raise RuntimeError('git not found — install Xcode CLI tools or git')


def do_update():
    repo = repo_root()
    before = git_output(['rev-parse', 'HEAD'], repo)
    run_git(['fetch', 'origin', 'main'], repo)
    run_git(['reset', '--hard', 'origin/main'], repo)
    after = git_output(['rev-parse', 'HEAD'], repo)
    if not after:
        raise RuntimeError('git update failed')

    changed = before != after
    version = '0.0.0'
    manifest_path = os.path.join(repo, 'manifest.json')
    if os.path.isfile(manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as fh:
            manifest = json.load(fh)
            version = str(manifest.get('version', version))

    return {
        'success': True,
        'changed': changed,
        'version': version,
        'commit': after,
        'message': 'Updated to v' + version if changed else 'Already up to date'
    }


def main():
    try:
        msg = read_message()
        if not msg:
            write_message({'success': False, 'error': 'No message'})
            return

        action = msg.get('action')
        if action == 'ping':
            write_message({'success': True, 'message': 'ok'})
        elif action == 'update':
            write_message(do_update())
        else:
            write_message({'success': False, 'error': 'Unknown action'})
    except Exception as err:
        write_message({'success': False, 'error': str(err)})


if __name__ == '__main__':
    main()