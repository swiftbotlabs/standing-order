// Node-only helper for the demo: the XO state package imports native SQLite modules at load time even when the
// IndexedDB storage (here: fake-indexeddb, pure JS) is used. This maps them to a stub so no native addon is built or downloaded.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "sqlite3" || spec === "better-sqlite3") return { url: "data:text/javascript,export default class NoNativeSqlite{constructor(){throw new Error('SQLite storage is not available in this demo; use StorageType.INDEXEDDB')}}; export const verbose=()=>({Database:class{}});", shortCircuit: true };
  return next(spec, ctx);
}`));
