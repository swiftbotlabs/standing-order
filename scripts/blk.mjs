import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const p = new ElectrumNetworkProvider("mainnet");
const tip = await p.getBlockHeight();
const hdr = await p.performRequest("blockchain.block.header", Number(process.argv[2]));
const ts = Buffer.from(hdr, "hex").readUInt32LE(68);
console.log("tip", tip, "| block", process.argv[2], "time", new Date(ts * 1000).toISOString());
process.exit(0);
