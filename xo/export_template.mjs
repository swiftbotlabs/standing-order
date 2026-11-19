// Writes standing-order.template.json with XO's own serializeTemplate (keeps bigints as extended JSON), so that importing the file
// in any XO wallet or in blaze.xo.cash gives the same template identifier the saved invitations reference.
import fs from "node:fs";
import { serializeTemplate } from "@xo-cash/utils";
import T from "./standing-order.template.mjs";
fs.writeFileSync(new URL("./standing-order.template.json", import.meta.url), serializeTemplate(T) + "\n");
console.log("wrote standing-order.template.json");
