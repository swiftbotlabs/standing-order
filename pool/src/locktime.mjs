// JS twin of src/locktime.ts (see there): raise nLockTime of every tx built inside withLocktime() to >= locktime,
// so the SDK's transfer-derivation probe sees the same CLTV floor as the final tx.
import { TransactionBuilder } from '@solidcash/solidcash';
const active = [];
const proto = TransactionBuilder.prototype;
if (!proto.__soLocktime) {
  const original = proto.buildLibauthTransaction;
  proto.buildLibauthTransaction = function patched(...args) {
    if (active.length > 0) { const want = Math.max(...active); if ((this.locktime ?? 0) < want) this.locktime = want; }
    return original.apply(this, args);
  };
  proto.__soLocktime = true;
}
export async function withLocktime(locktime, send) {
  if (!Number.isInteger(locktime) || locktime < 0 || locktime >= 500_000_000) throw new Error('locktime must be a block height');
  active.push(locktime);
  try { return await send(); } finally { active.splice(active.lastIndexOf(locktime), 1); }
}
