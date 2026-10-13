import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class IsolatedClientTests(unittest.TestCase):
    def test_job_socket_payload_and_cleanup_on_success_and_failure(self):
        for failure in (0, 23):
            with self.subTest(exit_status=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                trace = root / 'trace'
                fake = root / 'bin'
                fake.mkdir()
                programs = {
                    'tailscaled': '''import signal,socket,sys,time
path=next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--socket='))
sock=socket.socket(socket.AF_UNIX); sock.bind(path)
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
while True: time.sleep(.1)
''',
                    'tailscale': '''import json,os,pathlib,sys
args=sys.argv[1:]
path=next(arg.split('=',1)[1] for arg in args if arg.startswith('--socket='))
assert path.startswith('/tmp/tailscale-deploy.')
assert pathlib.Path(path).is_socket()
event='logout' if 'logout' in args else 'up'
if event=='up':
 assert '--advertise-tags=tag:deploy' in args
 assert '--accept-routes=false' in args
 assert '--accept-dns=false' in args
with open(os.environ['TEST_TRACE'],'a') as output: output.write(json.dumps({'event':event,'work':str(pathlib.Path(path).parent)})+'\\n')
''',
                    'ssh': '''import os,pathlib,sys
config=pathlib.Path(sys.argv[sys.argv.index('-F')+1]).read_text()
assert 'ProxyCommand tailscale --socket=/tmp/tailscale-deploy.' in config
assert 'StrictHostKeyChecking yes' in config
assert 'ForwardAgent no' in config
pathlib.Path(os.environ['TEST_PAYLOAD']).write_bytes(sys.stdin.buffer.read())
sys.exit(int(os.environ['TEST_SSH_STATUS']))
''',
                }
                for name, code in programs.items():
                    path = fake / name
                    path.write_text('#!/usr/bin/python3\n' + code)
                    path.chmod(0o755)
                env = {**os.environ, 'PATH': str(fake) + ':' + os.environ['PATH'],
                       'TEST_TRACE': str(trace), 'TEST_PAYLOAD': str(root / 'payload'),
                       'TEST_SSH_STATUS': str(failure), 'DEPLOY_HOST': '100.65.83.93',
                       'DEPLOY_USER': 'fixture-app', 'DEPLOY_HOST_KEY': 'ssh-ed25519 AQ==',
                       'TS_OAUTH_CLIENT_SECRET': 'test-only-placeholder',
                       'DEPLOY_SSH_KEY': 'test-only-placeholder', 'FORGEJO_RUN_ID': '1'}
                result = subprocess.run(['bash', str(Path(__file__).with_name('tailscale-ssh.sh'))],
                                        env=env, input=b'release-payload', capture_output=True, timeout=10)
                self.assertEqual(result.returncode, failure, result.stderr.decode())
                self.assertEqual((root / 'payload').read_bytes(), b'release-payload')
                events = [json.loads(line) for line in trace.read_text().splitlines()]
                self.assertEqual([entry['event'] for entry in events], ['up', 'logout'])
                self.assertFalse(Path(events[0]['work']).exists())

    def test_invalid_connection_settings_fail_before_credentials_or_network(self):
        for field, value in [('DEPLOY_HOST', 'example.com\nUser root'),
                             ('DEPLOY_USER', 'root\nProxyCommand malicious'),
                             ('DEPLOY_HOST_KEY', 'not-a-host-key')]:
            env = {**os.environ, 'DEPLOY_HOST': '100.65.83.93', 'DEPLOY_USER': 'fixture-app',
                   'DEPLOY_HOST_KEY': 'ssh-ed25519 AQ==', field: value}
            result = subprocess.run(['bash', str(Path(__file__).with_name('tailscale-ssh.sh'))],
                                    env=env, input=b'', capture_output=True)
            self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
