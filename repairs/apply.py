import base64
import gzip
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path.cwd()
OUT = ROOT / 'repair-results'
OUT.mkdir(exist_ok=True)
TOKEN = os.environ['GH_TOKEN']
REPO = 'maxcorrads/hivemind'
HEAD_ENV = dict(os.environ, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + TOKEN).encode()).decode())
TEST_ENV = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN') and not k.startswith('GIT_CONFIG_')}
TEST_ENV['npm_config_update_notifier'] = 'false'

def run(args, cwd=ROOT, env=None, log=None, timeout=300):
    result = subprocess.run(args, cwd=cwd, env=env or TEST_ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    output = result.stdout.replace(TOKEN, '[REDACTED]')
    if log is not None:
        log.write_text(output)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): ' + output[-5000:])
    return output.strip()

def pr_info(number):
    return json.loads(run(['gh', 'api', f'repos/{REPO}/pulls/{number}'], env=os.environ))

def dependency_head(spec):
    current = pr_info(int(spec['pr']))
    assert current['head']['repo']['full_name'] == REPO
    sha = current['head']['sha']
    run(['git', 'fetch', 'origin', sha], env=HEAD_ENV)
    assert run(['git', 'rev-parse', sha + '^{tree}']) == spec['expectedTree'], 'Dependency changed since integration test'
    return sha

manifest = json.loads((ROOT / 'repairs' / 'current.json').read_text())
results = []
for entry in manifest['repairs']:
    number = int(entry['pr'])
    report = {'pr': number, 'status': 'pending', 'steps': {}}
    results.append(report)
    try:
        pr = pr_info(number)
        branch = pr['head']['ref']
        assert pr['state'] == 'open' and pr['head']['repo']['full_name'] == REPO
        assert branch == entry['branch'] and re.fullmatch(r'(fix/issue-[0-9]+-[a-z0-9-]+|feature/500-agent-names)', branch)
        assert pr['head']['sha'] == entry['expectedHead'], 'PR head changed; do not overwrite it'
        work = ROOT / ('work-pr-' + str(number))
        run(['git', 'fetch', 'origin', entry['expectedHead']], env=HEAD_ENV)
        run(['git', 'worktree', 'add', '--detach', str(work), entry['expectedHead']])
        parents = [entry['expectedHead']]
        dependencies = entry.get('parents', [])
        if entry.get('contentBase'):
            base = dependency_head(entry['contentBase'])
            parents.append(base)
            run(['git', 'read-tree', '--reset', '-u', base], cwd=work)
        for dependency in dependencies:
            sha = dependency_head(dependency)
            if sha not in parents:
                parents.append(sha)
        patch = ROOT / 'repairs' / entry['patch']
        assert patch.resolve().is_relative_to((ROOT / 'repairs').resolve())
        if patch.name.endswith('.gz.b64'):
            decoded = OUT / f'{number}-decoded.patch'
            decoded.write_bytes(gzip.decompress(base64.b64decode(patch.read_text())))
            patch = decoded
        run(['git', 'apply', '--index', '--whitespace=error', str(patch)], cwd=work)
        run(['git', 'diff', '--cached', '--check'], cwd=work)
        tree = run(['git', 'write-tree'], cwd=work)
        assert tree == entry['expectedTree'], 'Tree differs from the locally tested repair'
        commands = [
            ('install', ['npm', 'ci', '--no-audit', '--no-fund']),
            ('typecheck', ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']),
            ('typecheck-web', ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.web.json']),
        ]
        for name, command in commands:
            started = time.monotonic()
            run(command, cwd=work, log=OUT / f'{number}-{name}.log')
            report['steps'][name] = {'passed': True, 'seconds': round(time.monotonic() - started, 2)}
        tests = sorted(str(p.relative_to(work)) for p in (work / 'src').rglob('*') if p.is_file() and re.search(r'\.test\.tsx?$', p.name))
        assert tests, 'No server tests discovered'
        run(['node', 'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', *tests], cwd=work, log=OUT / f'{number}-tests.log')
        report['steps']['tests'] = {'passed': True, 'files': len(tests)}
        ui = sorted(str(p.relative_to(work)) for p in (work / 'web').rglob('*') if p.is_file() and re.search(r'\.test\.tsx?$', p.name))
        if ui:
            run(['node', 'node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.web.json', '--test', '--test-concurrency=1', *ui], cwd=work, log=OUT / f'{number}-ui.log')
        report['steps']['ui'] = {'passed': True, 'files': len(ui)}
        run(['node', 'node_modules/vite/bin/vite.js', 'build'], cwd=work, log=OUT / f'{number}-build.log')
        report['steps']['build'] = {'passed': True}
        for dependency in dependencies + ([entry['contentBase']] if entry.get('contentBase') else []):
            assert dependency_head(dependency) in parents, 'Dependency moved during tests'
        assert pr_info(number)['head']['sha'] == entry['expectedHead'], 'PR moved during tests'
        author_env = dict(TEST_ENV, GIT_AUTHOR_NAME='Matteo Corradin', GIT_AUTHOR_EMAIL='16559094+maxcorrads@users.noreply.github.com', GIT_COMMITTER_NAME='Matteo Corradin', GIT_COMMITTER_EMAIL='16559094+maxcorrads@users.noreply.github.com')
        args = ['git', 'commit-tree', tree]
        for parent in parents:
            args += ['-p', parent]
        args += ['-m', entry['message']]
        commit = run(args, cwd=work, env=author_env)
        # No force push. The first parent is the checked original PR head.
        run(['git', 'push', 'origin', f'{commit}:refs/heads/{branch}'], cwd=work, env=HEAD_ENV)
        assert pr_info(number)['head']['sha'] == commit, 'Push could not be verified'
        report.update(status='pushed', commit=commit, tree=tree, branch=branch)
    except Exception as exc:
        report.update(status='failed', error=str(exc).replace(TOKEN, '[REDACTED]'))
    print(json.dumps(report), flush=True)
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))
if any(r['status'] != 'pushed' for r in results):
    sys.exit(1)
