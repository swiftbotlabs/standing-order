// WizardConnect session for the dapp. Integration rules proven in scripts/e2e_wizard.mjs:
// manager first; the relay status callback feeds mgr.updateConnection(); never stringify the status object.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { hash160, decodeHdPublicKey, deriveHdPublicNodeChild } from '@bitauth/libauth';
import type { Net } from './chain';
import { addressOfHash } from './chain';

export interface WalletInfo { name: string; pubkey: Uint8Array; hash: Uint8Array; address: string }

export class WizardSession {
  private mgr: DappConnectionManager | null = null;
  private relay: ReturnType<typeof initiateDappRelay> | null = null;
  uri = '';
  wallet: WalletInfo | null = null;
  net: Net | null = null;   // network of the current session (pay pages reuse it when it matches)

  start(net: Net, onStatus: (s: string) => void, onReady: (w: WalletInfo) => void, onGone: () => void): string {
    this.stop();
    this.net = net;
    const mgr = new DappConnectionManager('Standing Order', `${location.origin}/icon.png`, { session: false });
    this.mgr = mgr;
    let relayRef: ReturnType<typeof initiateDappRelay> | null = null;
    const relay = initiateDappRelay((st: any) => {
      onStatus(String(st?.status?.status ?? st?.status ?? ''));
      mgr.updateConnection(relayRef?.client ?? null, st);
    });
    relayRef = relay;
    this.relay = relay;
    mgr.updateConnection(relay.client, { status: 'connecting' } as any);
    mgr.attachRelay(relay);
    mgr.on('walletready', () => {
      let pubkey = mgr.getPubkey(0, 0n);
      if (!pubkey) {
        // Some wallets name their paths differently: find the receive path ourselves and derive index 0.
        const paths = (mgr.getSessionPaths?.() || []) as any[];
        const rx = paths.find((p) => /receive|^0$|\/0$/i.test(String(p?.name ?? ''))) || paths[0];
        if (rx?.xpub) {
          const d: any = decodeHdPublicKey(rx.xpub);
          if (typeof d !== 'string') {
            const child: any = deriveHdPublicNodeChild(d.node, 0);
            if (typeof child !== 'string') pubkey = child.publicKey;
          }
        }
        if (!pubkey) {
          // Selene first sends wallet_ready with no paths and shares its keys only after the user approves the
          // connection in the wallet (a second wallet_ready). Keep waiting instead of failing.
          onStatus(paths.length ? `wallet sent no usable key (paths: ${paths.map((p) => String(p?.name)).join(', ')})` : `approve the connection in ${mgr.walletName || 'your wallet'}`);
          return;
        }
      }
      const hash = hash160(pubkey);
      this.wallet = { name: mgr.walletName || 'Wallet', pubkey, hash, address: addressOfHash(hash, net) };
      onReady(this.wallet);
    });
    mgr.on('disconnect', () => { this.wallet = null; onGone(); });
    this.uri = relay.uri;
    return relay.uri;
  }

  // Sends the sign request and waits for the wallet's answer. The library's signTransaction() gives up when the relays do not
  // confirm the publish within ~8 s, although the request usually reached the wallet (mainnet capture 17 Nov: the wallet signed
  // 1.5 s after the page had given up). So a slow publish is not a failure here: the request stays pending and the wallet's
  // answer resolves it (the manager also re-sends pending requests after a reconnect). Only no answer at all times out.
  async sign(wc: unknown, inputPaths: [number, string, number][], waitMs = 180_000): Promise<string> {
    const mgr: any = this.mgr;
    if (!mgr || !this.wallet) throw new Error('Connect a wallet first.');
    const sequence = mgr.nextSequence();
    const request = { action: 'sign_transaction_request', time: Math.floor(Date.now() / 1000), sequence, transaction: wc, inputPaths };
    const r: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mgr.pendingSignatureRequests.delete(sequence);
        reject(new Error('No answer from your wallet within 3 minutes. If it shows the request, approve it and press the button again.'));
      }, waitMs);
      mgr.pendingSignatureRequests.set(sequence, {
        request,
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v); },
        reject: (e: unknown) => { clearTimeout(timer); reject(e); },
      });
      mgr.conn.relay(request).then(() => mgr.emit('messagesent', request))
        .catch((e: unknown) => console.warn('[standing-order] relay did not confirm the sign request in time; still waiting for the wallet', e));
    });
    if (r?.error) throw new Error(`The wallet declined: ${r.error}`);
    if (!r?.signedTransaction) throw new Error('The wallet returned no transaction.');
    return r.signedTransaction;
  }

  stop(): void {
    try { this.mgr?.sendDisconnect('closed'); } catch { /* ignore */ }
    try { this.relay?.cleanup(); } catch { /* ignore */ }
    this.mgr = null; this.relay = null; this.wallet = null; this.uri = ''; this.net = null;
  }
}

// One relay socket failing must not take the page down.
window.addEventListener('unhandledrejection', (e) => { if (/WebSocket/i.test(String((e as any).reason?.message))) e.preventDefault(); });
