#!/usr/bin/python3
"""Fixed receiver for Athena's Linux executable, installed by an administrator."""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

HOME = Path('/var/lib/athena')
MAX_BINARY = 128 * 1024 * 1024


def receive_binary(stream, target, expected_digest, expected_size):
    if not 64 <= expected_size <= MAX_BINARY:
        raise ValueError('Invalid executable size')
    digest = hashlib.sha256()
    size = 0
    with target.open('xb') as output:
        header = stream.read(64)
        if (len(header) != 64 or header[:6] != b'\x7fELF\x02\x01'
                or int.from_bytes(header[18:20], 'little') != 62):
            raise ValueError('Expected a Linux x86-64 ELF executable')
        output.write(header)
        digest.update(header)
        size += len(header)
        while chunk := stream.read(65536):
            size += len(chunk)
            if size > MAX_BINARY or size > expected_size:
                raise ValueError('Executable is too large')
            output.write(chunk)
            digest.update(chunk)
    if size != expected_size or digest.hexdigest() != expected_digest:
        raise ValueError('Truncated or corrupted executable')
    target.chmod(0o700)


def point(link, target):
    temporary = link.with_name(link.name + '.next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(link)


def service(action):
    subprocess.run(['/usr/bin/systemctl', '--user', action, 'athena.service'], check=True)


def activate(home, binary, control=service):
    current = home / 'current'
    previous = current.resolve(strict=True)
    if previous.parent != home / 'releases':
        raise ValueError('Unexpected current executable')
    control('stop')
    try:
        point(current, binary)
        control('reset-failed')
        # Type=notify waits until Athena has connected to Discord.
        control('start')
        control('is-active')
    except BaseException:
        control('stop')
        point(current, previous)
        control('reset-failed')
        control('start')
        control('is-active')
        raise
    point(home / 'previous', previous)


def main():
    os.umask(0o077)
    os.environ['PATH'] = '/usr/bin:/bin'
    command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if command == 'verify':
        print('athena-receiver-v1')
        return
    if command != 'deploy':
        raise ValueError('Only deploy and verify are permitted')
    if not (HOME / 'ready').is_file():
        raise ValueError('Complete the administrator migration first')
    revision = sys.stdin.buffer.readline(42)
    if not re.fullmatch(rb'[0-9a-f]{40}\n', revision):
        raise ValueError('Expected a commit SHA')
    metadata = sys.stdin.buffer.readline(80)
    if not re.fullmatch(rb'[0-9a-f]{64} [0-9]{1,9}\n', metadata):
        raise ValueError('Expected executable checksum and size')
    expected_digest, expected_size = metadata.decode().split()
    with (HOME / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fd, filename = tempfile.mkstemp(prefix=revision.decode().strip() + '-', dir=HOME / 'releases')
        os.close(fd)
        binary = Path(filename)
        binary.unlink()
        try:
            receive_binary(sys.stdin.buffer, binary, expected_digest, int(expected_size))
            activate(HOME, binary)
            retained = {(HOME / name).resolve() for name in ('current', 'previous')}
            for old in (HOME / 'releases').iterdir():
                if old not in retained and old.is_file() and not old.is_symlink():
                    old.unlink()
            print('Healthy executable:', revision.decode().strip())
        finally:
            if binary not in {(HOME / name).resolve() for name in ('current', 'previous')}:
                binary.unlink(missing_ok=True)


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise InterruptedError('Deployment interrupted')

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
