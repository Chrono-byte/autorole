import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import receive


def executable():
    header = bytearray(64)
    header[:6] = b'\x7fELF\x02\x01'
    header[18:20] = (62).to_bytes(2, 'little')
    return bytes(header) + b'payload'


class ReceiverTests(unittest.TestCase):
    def test_accepts_x86_64_binary_without_paths_or_service_files(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'binary'
            receive.receive_binary(io.BytesIO(executable()), target, hashlib.sha256(executable()).hexdigest(), len(executable()))
            self.assertEqual(target.read_bytes(), executable())
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_rejects_scripts_wrong_architecture_and_oversized_binary(self):
        arm = bytearray(executable())
        arm[18:20] = (183).to_bytes(2, 'little')
        for contents in (b'#!/bin/bash\n' + b'x' * 80, bytes(arm), executable() + b'x' * 100):
            with self.subTest(contents=contents[:8]), tempfile.TemporaryDirectory() as directory:
                with patch.object(receive, 'MAX_BINARY', 100), self.assertRaises(ValueError):
                    receive.receive_binary(io.BytesIO(contents), Path(directory) / 'binary', hashlib.sha256(contents).hexdigest(), len(contents))

    def test_truncated_or_corrupted_executable_is_denied_before_activation(self):
        for contents in (executable()[:-1], executable()[:-1] + b'X'):
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                receive.receive_binary(io.BytesIO(contents), Path(directory) / 'binary',
                                       hashlib.sha256(executable()).hexdigest(), len(executable()))

    def test_readiness_failure_restores_previous_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            releases = home / 'releases'
            releases.mkdir()
            old = releases / 'old'
            new = releases / 'new'
            old.touch()
            new.touch()
            (home / 'current').symlink_to(old)
            failed = False
            actions = []

            def control(action):
                nonlocal failed
                actions.append(action)
                if action == 'start' and not failed:
                    failed = True
                    raise RuntimeError('Discord readiness failed')

            with self.assertRaises(RuntimeError):
                receive.activate(home, new, control)
            self.assertEqual((home / 'current').resolve(), old)
            self.assertEqual(actions.count('stop'), 2)
            self.assertEqual(actions.count('start'), 2)

    def test_arbitrary_ssh_command_is_denied(self):
        import os
        import subprocess
        result = subprocess.run(['python3', str(Path(__file__).with_name('receive.py'))],
                                env={**os.environ, 'SSH_ORIGINAL_COMMAND': 'bash -s'}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Only deploy and verify', result.stderr)


if __name__ == '__main__':
    unittest.main()
