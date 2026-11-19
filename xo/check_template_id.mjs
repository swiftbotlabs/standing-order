// Imports standing-order.template.json (the file, as a string) into a throwaway XO engine and prints the template identifier.
import "fake-indexeddb/auto";
import fs from "node:fs";
import { Engine, XO_SUPPORTED_NETWORKS } from "@xo-cash/engine";
import { StorageType } from "@xo-cash/state";
const json = fs.readFileSync(new URL("./standing-order.template.json", import.meta.url), "utf8");
const inv = JSON.parse(fs.readFileSync(new URL("./invitations/1-fund.xo.json", import.meta.url), "utf8"));
const e = await Engine.create(fs.readFileSync(process.env.XO_MNEMONIC_FILE, "utf8").trim(), { network: XO_SUPPORTED_NETWORKS.chipnet, storageType: StorageType.INDEXEDDB, databaseFilename: "XO-id-check" });
const { templateIdentifier } = await e.importTemplate(json);
console.log("file imports as", templateIdentifier);
console.log("invitations use ", inv.templateIdentifier, templateIdentifier === inv.templateIdentifier ? "MATCH" : "MISMATCH");
await e.stop(); process.exit(templateIdentifier === inv.templateIdentifier ? 0 : 1);
