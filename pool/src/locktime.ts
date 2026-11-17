// SolidCash 0.51: `require(tx.time >= n)` is a CLTV check on nLockTime. `.setLocktime(n)` sets the FINAL tx's locktime,
// but when the call also has a `this.transfer(...)`, the SDK first runs a derivation probe built with locktime 0, and
// that probe fails the CLTV ("not due yet") before the final tx is built. `withLocktime` raises the locktime of every
// transaction built inside it (probe and final) to at least `locktime`. It only changes nLockTime, which the covenant
// itself checks; nothing is skipped. (Same idea as FoldClaim's withRelativeLock for nSequence.)
import { TransactionBuilder } from '@solidcash/solidcash';

const active: number[] = [];
const proto = TransactionBuilder.prototype as any;
if (!proto.__soLocktime) {
  const original = proto.buildLibauthTransaction;
  proto.buildLibauthTransaction = function patched(this: any, ...args: unknown[]) {
    if (active.length > 0) {
      const want = Math.max(...active);
      if ((this.locktime ?? 0) < want) this.locktime = want;
    }
    return original.apply(this, args);
  };
  proto.__soLocktime = true;
}

export async function withLocktime<T>(locktime: number, send: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(locktime) || locktime < 0 || locktime >= 500_000_000) throw new Error('locktime must be a block height');
  active.push(locktime);
  try { return await send(); } finally { active.splice(active.lastIndexOf(locktime), 1); }
}
