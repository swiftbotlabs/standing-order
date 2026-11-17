#!/usr/bin/env python3
"""Planted positive controls: weaken the contract one way at a time; the suite must go red for each."""
import subprocess, os, tempfile, sys
TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tmp'); os.makedirs(TMP, exist_ok=True)
SRC = open('contracts/standing_order_pool.scash').read()
MUT = {
 'no CLTV (collect early)': ('        require(tx.time >= due, "not due yet");\n', ''),
 'no due check per member': ('            require(rec / 65536 + lastOffset <= due, "member not due");\n', ''),
 'no budget check': ('            require(rec % 65536 >= periods, "not enough prepaid periods");\n', ''),
 'anyone can withdraw': ('        require(tx.origin == new LockingBytecodeP2PKH(subscriber), "only the member can withdraw");\n', ''),
 'withdraw more than left': ('require(periods >= 1 && periods <= left, "bad number of periods");', 'require(periods >= 1, "bad number of periods");'),
 'leave with periods left': ('        require(rec % 65536 == 0, "withdraw the prepaid periods instead");\n', ''),
 'collect pays double': ('this.transfer(new LockingBytecodeP2PKH(merchant), total);', 'this.transfer(new LockingBytecodeP2PKH(merchant), total * 2);'),
 'deposit not whole periods': ('require(deposit >= price && deposit % price == 0, "deposit must be whole periods");', 'require(deposit > 0, "deposit must be whole periods");'),
  'no key order check': ('            require(i == 0 || unsafe_int(subscribers[i] + 0x01) > unsafe_int(subscribers[i - 1] + 0x01), "list members in ascending order, once each");\n', ''),
  'anyone can leave': ('        require(hash160(pk) == subscriber, "only the member can leave");\n', ''),
}
ok = True
for name, (a, b) in MUT.items():
    assert SRC.count(a) == 1, name
    d = tempfile.mkdtemp(prefix='pc_', dir=TMP); f = os.path.join(d, 'pool.scash'); open(f, 'w').write(SRC.replace(a, b))
    r = subprocess.run(['npx', '--no-install', 'vitest', 'run', '-c', 'vitest.config.mjs'], env={**os.environ, 'POOL_SCASH': f}, capture_output=True, text=True)
    failed = [l.strip() for l in (r.stdout + r.stderr).splitlines() if 'Tests' in l and 'failed' in l]
    red = r.returncode != 0 and bool(failed)
    print(('RED (good)' if red else 'GREEN (BAD: control not caught)'), '|', name, '|', failed[0] if failed else '')
    ok &= red
sys.exit(0 if ok else 1)
