import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const p = new ElectrumNetworkProvider("mainnet");
for (const a of process.argv.slice(2)) {
  const u = await p.getUtxos(a);
  const bch = u.filter((x) => !x.token).reduce((s, x) => s + x.satoshis, 0n);
  console.log(a.slice(0, 26), "BCH sats:", bch.toString(), "| token utxos:", u.filter((x) => x.token).length);
}
process.exit(0);
