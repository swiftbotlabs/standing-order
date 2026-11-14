import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const p = new ElectrumNetworkProvider("chipnet");
for (const txid of process.argv.slice(2)) {
  try {
    const v = await p.performRequest("blockchain.transaction.get", txid, true);
    console.log(txid.slice(0, 12), "confirmations:", v.confirmations ?? 0, "blockhash:", (v.blockhash || "mempool").slice(0, 16), "version:", v.version);
  } catch (e) { console.log(txid.slice(0, 12), "ERR", String(e?.message || e).slice(0, 200)); }
}
console.log("height", await p.getBlockHeight());
process.exit(0);
