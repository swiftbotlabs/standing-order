import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const p = new ElectrumNetworkProvider("mainnet");
const u = await p.getUtxos(process.argv[2]);
const hist = await p.performRequest("blockchain.address.get_history", process.argv[2]);
for (const x of u.filter((x) => x.token)) {
  const h = hist.find((y) => y.tx_hash === x.txid);
  console.log("token utxo", x.txid.slice(0, 16), "vout", x.vout, "| category", x.token.category.slice(0, 16) + "...", "| amount", x.token.amount.toString(), "| height", h?.height);
}
console.log("history txs:", hist.length, hist.map((h) => h.height).join(","));
process.exit(0);
