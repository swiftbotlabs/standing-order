// Writes standing-order.template.json with XO's own serializeTemplate (keeps bigints as extended JSON), so that importing the file
// in any XO wallet or in blaze.xo.cash gives the same template identifier the saved invitations reference.
import fs from "node:fs";
import { serializeTemplate } from "@xo-cash/utils";
import T from "./standing-order.template.mjs";
import P from "./standing-order-plus.template.mjs";
fs.writeFileSync(new URL("./standing-order.template.json", import.meta.url), serializeTemplate(T) + "\n");
fs.writeFileSync(new URL("./standing-order-plus.template.json", import.meta.url), serializeTemplate(P) + "\n");
console.log("wrote standing-order.template.json and standing-order-plus.template.json");
