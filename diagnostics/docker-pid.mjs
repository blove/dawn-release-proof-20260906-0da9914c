import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source=path.resolve('source'),lane=process.argv[2],output=path.join(process.env.RUNNER_TEMP,'shared-diagnostic');
await mkdir(output,{recursive:true});
const moduleAt=(file)=>import(pathToFileURL(path.join(source,file)));
const {createStrictSmokeProcessRunner}=await moduleAt('scripts/release/smoke-process-runner.mjs');
const {executeSmokeOperation}=await moduleAt('scripts/release/smoke-result.mjs');
const {publicNpmEnvironment}=await moduleAt('scripts/lib/published-artifacts.mjs');
const {readInstalledResolutions}=await moduleAt('scripts/release/recovery/smoke.mjs');
const names={'scaffold':'executeScaffoldSmoke','runtime-targets':'executeRuntimeTargetsSmoke','published-harness':'executePublishedHarnessSmoke','storage':'executeStorageSmoke'};
if(!Object.hasOwn(names,lane))throw new Error('Invalid diagnostic lane');
const operation=(await moduleAt('scripts/release/smoke/'+lane+'.mjs'))[names[lane]];
const {candidate}=JSON.parse(await readFile(path.join(source,'scripts/release/recovery-adoptions/v0.8.24.json'),'utf8'));
await writeFile(path.join(output,'NOTICE.txt'),`Diagnostic only, not recovery evidence. ${lane}. Node ${process.version} ${process.platform}. Source 147a3a0659717ae936d899abb40dc9b559280f55. No receipt/executor authority.\n`);
let seq=0;const roots=new Set(),raw=createStrictSmokeProcessRunner();
async function log(name,value){await writeFile(path.join(output,name),String(value).slice(0,4*1024*1024)+'\n');}
const strictRunner={probe:()=>raw.probe(),async runCommand(command,args,options={}){const id=String(++seq).padStart(3,'0');if(options.cwd)roots.add(options.cwd);await log(id+'-command.txt',JSON.stringify({command,args,cwd:options.cwd}));try{const result=await raw.runCommand(command,args,options);await log(id+'-stdout.log',result.stdout);await log(id+'-stderr.log',result.stderr);return result;}catch(error){await log(id+'-error.log',error.stack+'\n'+(error.stderr??''));throw error;}}};
async function collectLogs(){for(const [i,root] of [...roots].entries()){try{const dir=path.join(root,'.npm-cache/_logs');for(const file of (await readdir(dir)).slice(-12))if(file.endsWith('.log'))await log('npm-'+i+'-'+file,await readFile(path.join(dir,file),'utf8'));}catch{}}}
async function captureInstallation(check,root){console.log('CAPTURE '+check);await strictRunner.runCommand('npm',['ls','--all','--json'],{cwd:root,env:publicNpmEnvironment({home:root}),timeoutMs:60000,maxOutputBytes:16*1024*1024});const rows=await readInstalledResolutions(root,candidate);await log(check+'-inventory.txt','Diagnostic inventory read passed; count '+rows.length);console.log('CAPTURE PASS '+check+' '+rows.length);}
const outcome=await executeSmokeOperation(async context=>{await operation({version:candidate.version,commitSha:candidate.candidateSha,manifestSha256:candidate.manifestSha256,manifest:path.resolve('diagnostics/manifest.json')},{...context,async check(name,detail,action){console.log('START '+name);return context.check(name,detail,async()=>{try{const result=await action();console.log('PASS '+name);return result;}catch(error){await log('failure-'+name+'.log',error.stack);console.error('FAIL '+name+'\n'+error.stack);throw error;}});},deferCleanup(name,detail,action){context.deferCleanup(name,detail,async()=>{await collectLogs();console.log('CLEANUP '+name);await action();console.log('CLEANUP PASS '+name);});},captureInstallation,async captureDockerImage(reference,digest){await log('docker-image-'+(++seq)+'.txt',JSON.stringify({diagnosticOnly:true,reference,digest}));}},{strictRunner});});
await log('outcome.txt',JSON.stringify({diagnosticOnly:true,lane,conclusion:outcome.conclusion,checks:outcome.checks,errors:outcome.errors.map(x=>x.stack)},null,2));
try { await strictRunner.runCommand('docker',['image','inspect','node:22-slim','--format','{{json .RepoDigests}} {{.Id}}'],{cwd:source,env:publicNpmEnvironment({home:output}),timeoutMs:60000,maxOutputBytes:1048576}); } catch(error) { await log('docker-image-inspection-error.txt',error.message); }
console.log('DIAGNOSTIC '+outcome.conclusion);if(outcome.conclusion!=='success')process.exitCode=1;
