import { compileFile } from '@solidcash/solidc';
const f = process.argv[2];
try { const a = compileFile(new URL(f, import.meta.url)); console.log('OK', a.contractName, 'bytes', a.bytecode?.length/2|0, 'abi', a.abi.map(x=>x.name+(x.transferCount?`[t${x.transferCount}]`:'')).join(',')); console.log('state', JSON.stringify(a.stateLayout?.variables?.map(v=>v.name))); }
catch (e) { console.log('ERR', String(e?.message||e).slice(0,1500)); }
