#!/usr/bin/env python3
"""SardarJi native messaging host — git sync from GitHub (macOS / Linux)."""

import json
import os
import platform
import shutil
import struct
import subprocess
import sys

EXTENSION_ID = 'jonocdekbjneapljhkeijonmdkkekjcm'
SKIP_COPY_NAMES = {'.git', 'com.sardarji.updater.installed.json'}


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


def chrome_user_data_dir():
    system = platform.system()
    if system == 'Darwin':
        return os.path.expanduser('~/Library/Application Support/Google/Chrome')
    if system == 'Windows':
        return os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Google', 'Chrome', 'User Data')
    return os.path.expanduser('~/.config/google-chrome')


def chrome_extension_load_path():
    base = chrome_user_data_dir()
    if not base or not os.path.isdir(base):
        return None
    for profile in os.listdir(base):
        sec_path = os.path.join(base, profile, 'Secure Preferences')
        if not os.path.isfile(sec_path):
            continue
        try:
            with open(sec_path, 'r', encoding='utf-8') as fh:
                prefs = json.load(fh)
            ext = prefs.get('extensions', {}).get('settings', {}).get(EXTENSION_ID, {})
            load_path = ext.get('path')
            if load_path and os.path.isfile(os.path.join(load_path, 'manifest.json')):
                return load_path
        except (OSError, json.JSONDecodeError, TypeError):
            continue
    return None


def sync_repo_to_chrome_load_path(repo):
    dest = chrome_extension_load_path()
    if not dest:
        return False
    repo_norm = os.path.normcase(os.path.abspath(repo))
    dest_norm = os.path.normcase(os.path.abspath(dest))
    if repo_norm == dest_norm:
        return False

    changed = False
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_COPY_NAMES]
        rel = os.path.relpath(root, repo)
        target_root = dest if rel == '.' else os.path.join(dest, rel)
        os.makedirs(target_root, exist_ok=True)
        for name in files:
            if name in SKIP_COPY_NAMES:
                continue
            src = os.path.join(root, name)
            dst = os.path.join(target_root, name)
            if not os.path.isfile(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
                shutil.copy2(src, dst)
                changed = True
            else:
                with open(src, 'rb') as sf, open(dst, 'rb') as df:
                    if sf.read() != df.read():
                        shutil.copy2(src, dst)
                        changed = True
    return changed


def do_update():
    repo = repo_root()
    before = git_output(['rev-parse', 'HEAD'], repo)
    run_git(['fetch', 'origin', 'main'], repo)
    run_git(['reset', '--hard', 'origin/main'], repo)
    after = git_output(['rev-parse', 'HEAD'], repo)
    if not after:
        raise RuntimeError('git update failed')

    git_changed = before != after
    copy_changed = sync_repo_to_chrome_load_path(repo)
    changed = git_changed or copy_changed
    version = '0.0.0'
    manifest_path = os.path.join(repo, 'manifest.json')
    if os.path.isfile(manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as fh:
            manifest = json.load(fh)
            version = str(manifest.get('version', version))

    if git_changed:
        message = 'Updated to v' + version
    elif copy_changed:
        message = 'Synced files to Chrome load folder (v' + version + ')'
    else:
        message = 'Already up to date'

    return {
        'success': True,
        'changed': changed,
        'version': version,
        'commit': after,
        'message': message
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