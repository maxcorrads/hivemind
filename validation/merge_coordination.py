import subprocess, pathlib, tempfile
BASE='45842238561ae985b68e20a3103485d45a6c5912'; SOURCE='f039306217e13f07a28716aba1ee42137dbec165'
def run(*a): return subprocess.check_output(['git',*a])
assert run('rev-parse','HEAD^{tree}').decode().strip() == '1b2c15c5e7d05392b01b21cf0f69e4781929f61f'
paths=run('diff','--name-only',BASE,SOURCE).decode().splitlines()
conf=[]
for name in paths:
    p=pathlib.Path(name)
    def version(ref):
        r=subprocess.run(['git','show',f'{ref}:{name}'],capture_output=True)
        return r.stdout if r.returncode==0 else b''
    base=version(BASE); theirs=version(SOURCE); ours=p.read_bytes() if p.exists() else b''
    if theirs==base: continue
    if not p.exists() and not base:
        p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(theirs);continue
    with tempfile.TemporaryDirectory() as d:
        fs=[pathlib.Path(d)/str(i) for i in range(3)]
        for f,data in zip(fs,[ours,base,theirs]):f.write_bytes(data)
        r=subprocess.run(['git','merge-file','-p','-L','CURRENT','-L','PRE_TASK_SOURCE','-L','COORDINATION',*[str(f) for f in fs]],capture_output=True)
        if r.returncode>=128: raise RuntimeError(name+str(r.stderr))
        p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(r.stdout)
        if r.returncode: conf.append((name,r.returncode))
print('Conflicts:',conf)
