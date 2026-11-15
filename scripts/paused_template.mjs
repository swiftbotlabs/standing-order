// Prints the PausedOrder redeem-script template (the redeem script without its two constructor pushes), which
// StandingOrderPlus embeds as PAUSED_TEMPLATE to compute the paused covenant's address on chain.
import { readFileSync } from 'node:fs';
import { Contract } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
const art = JSON.parse(readFileSync(new URL('../artifacts/solidcash/paused_order.json', import.meta.url)));
const sub = new Uint8Array(20).fill(0xab), to = new Uint8Array(32).fill(0xcd);
const c = new Contract(art, [sub, to], { provider: new MockNetworkProvider() });
const hex = c.bytecode;
const prefix = '20' + 'cd'.repeat(32) + '14' + 'ab'.repeat(20);
if (!hex.startsWith(prefix)) throw new Error('unexpected arg layout: ' + hex.slice(0, 120));
console.log(hex.slice(prefix.length));
