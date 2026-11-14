// WizardConnect session for the dapp. Integration rules proven in scripts/e2e_wizard.mjs:
// manager first; the relay status callback feeds mgr.updateConnection(); never stringify the status object.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { hash160 } from '@bitauth/libauth';
import type { Net } from './chain';
import { addressOfHash } from './chain';

export interface WalletInfo { name: string; pubkey: Uint8Array; hash: Uint8Array; address: string }

export class WizardSession {
  private mgr: DappConnectionManager | null = null;
  private relay: ReturnType<typeof initiateDappRelay> | null = null;
  uri = '';
  wallet: WalletInfo | null = null;

  start(net: Net, onStatus: (s: string) => void, onReady: (w: WalletInfo) => void, onGone: () => void): string {
    this.stop();
    const mgr = new DappConnectionManager('Standing Order', `${location.origin}/icon.png`, { session: false });
    this.mgr = mgr;
    let relayRef: ReturnType<typeof initiateDappRelay> | null = null;
    const relay = initiateDappRelay((st: any) => {
      onStatus(String(st?.status ?? ''));
      mgr.updateConnection(relayRef?.client ?? null, st);
    });
    relayRef = relay;
    this.relay = relay;
    mgr.updateConnection(relay.client, { status: 'connecting' } as any);
    mgr.attachRelay(relay);
    mgr.on('walletready', () => {
      const pubkey = mgr.getPubkey(0, 0n);
      if (!pubkey) { onStatus('wallet sent no receive key'); return; }
      const hash = hash160(pubkey);
      this.wallet = { name: mgr.walletName || 'Wallet', pubkey, hash, address: addressOfHash(hash, net) };
      onReady(this.wallet);
    });
    mgr.on('disconnect', () => { this.wallet = null; onGone(); });
    this.uri = relay.uri;
    return relay.uri;
  }

  async sign(wc: unknown, inputPaths: [number, string, number][]): Promise<string> {
    if (!this.mgr || !this.wallet) throw new Error('Connect a wallet first.');
    const r: any = await this.mgr.signTransaction({ transaction: wc as any, inputPaths } as any);
    if (r?.error) throw new Error(`The wallet declined: ${r.error}`);
    if (!r?.signedTransaction) throw new Error('The wallet returned no transaction.');
    return r.signedTransaction;
  }

  stop(): void {
    try { this.mgr?.sendDisconnect('closed'); } catch { /* ignore */ }
    try { this.relay?.cleanup(); } catch { /* ignore */ }
    this.mgr = null; this.relay = null; this.wallet = null; this.uri = '';
  }
}

// One relay socket failing must not take the page down.
window.addEventListener('unhandledrejection', (e) => { if (/WebSocket/i.test(String((e as any).reason?.message))) e.preventDefault(); });
