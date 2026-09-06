import {mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
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
await writeFile(path.join(output,'NOTICE.txt'),`Diagnostic only, not recovery evidence. ${lane}. Node ${process.version} ${process.platform}. Source 0a6bb55b972c5bd9af8414adf2a3338789381588. No receipt/executor authority.\n`);
let seq=0;const roots=new Set(),raw=createStrictSmokeProcessRunner();
async function log(name,value){await writeFile(path.join(output,name),String(value).slice(0,4*1024*1024)+'\n');}
const strictRunner={probe:()=>raw.probe(),async runCommand(command,args,options={}){const id=String(++seq).padStart(3,'0');if(options.cwd)roots.add(options.cwd);await log(id+'-command.txt',JSON.stringify({command,args,cwd:options.cwd}));try{const result=await raw.runCommand(command,args,options);await log(id+'-stdout.log',result.stdout);await log(id+'-stderr.log',result.stderr);return result;}catch(error){await log(id+'-error.log',error.stack+'\n'+(error.stderr??''));throw error;}}};
async function collectLogs(){for(const [i,root] of [...roots].entries()){try{const dir=path.join(root,'.npm-cache/_logs');for(const file of (await readdir(dir)).slice(-12))if(file.endsWith('.log'))await log('npm-'+i+'-'+file,await readFile(path.join(dir,file),'utf8'));}catch{}}}
async function captureInstallation(check,root){console.log('CAPTURE '+check);await strictRunner.runCommand('npm',['ls','--all','--json'],{cwd:root,env:publicNpmEnvironment({home:root}),timeoutMs:60000,maxOutputBytes:16*1024*1024});const rows=await readInstalledResolutions(root,candidate);await log(check+'-inventory.txt','Diagnostic inventory read passed; count '+rows.length);console.log('CAPTURE PASS '+check+' '+rows.length);}
const {runDockerSandboxInstalledProbe}=await moduleAt('scripts/published-artifact-smoke.mjs');
const {publishedDockerProbeIdentity,cleanupDockerSandboxResources}=await moduleAt('scripts/release/smoke/published-harness.mjs');
const probeCommand=async(command,args,options={})=>{
 if(command==='node'&&args[0]==='smoke-docker-sandbox.mjs'){
  const file=path.join(options.cwd,args[0]);let bytes=await readFile(file,'utf8');
  const saturation='  assert.equal(saturated.stdout.trim(), String(pidsLimit))';
  const replacement='  assert.notEqual(replacementKeeperId, originalKeeperId, "PID-exhausted keeper was not replaced")';
  if(bytes.split(saturation).length!==2||bytes.split(replacement).length!==2)throw new Error('Diagnostic insertion anchors changed');
  bytes=bytes.replace(saturation,saturation+'\n  await handle.filesystem.writeFile("/workspace/published-pid-recovery.txt", sentinel, context(handle.workspaceRoot))');
  bytes=bytes.replace(replacement,replacement+'\n  assert.equal(await handle.filesystem.readFile("/workspace/published-pid-recovery.txt", context(handle.workspaceRoot)), sentinel)\n  console.log("DIAGNOSTIC PID PROOF " + JSON.stringify({pids:saturated.stdout.trim(),originalKeeperId,replacementKeeperId,scope:"filesystem-triggered recovery then24concurrentcommands"}))');
  await writeFile(file,bytes);
 }
 return strictRunner.runCommand(command,args,{...options,env:publicNpmEnvironment({home:options.cwd??source,extra:options.env}),timeoutMs:600000,maxOutputBytes:4*1024*1024});
};
async function repeatDockerProbe(root,firstIdentity){
 for(let trial=1;trial<=10;trial++){
  const identity=trial===1?firstIdentity:publishedDockerProbeIdentity();let primary;
  console.log('DOCKER TRIAL '+trial+' START');
  await rm(path.join(root,'docker-image.json'),{force:true});
  try{await runDockerSandboxInstalledProbe(root,{runCommand:probeCommand,threadId:identity.threadId,imageEvidencePath:'docker-image.json'});await log('trial-'+trial+'-image.txt',await readFile(path.join(root,'docker-image.json'),'utf8'));console.log('DOCKER TRIAL '+trial+' PASS');}
  catch(error){primary=error;await log('trial-'+trial+'-failure.log',error.stack+'\n'+(error.stderr??''));console.error('DOCKER TRIAL '+trial+' FAIL '+error.message);}
  finally{try{await log('trial-'+trial+'-probe-source.mjs',await readFile(path.join(root,'smoke-docker-sandbox.mjs'),'utf8'));}catch{}try{await cleanupDockerSandboxResources(identity,{runCommand:probeCommand});console.log('DOCKER TRIAL '+trial+' CLEANUP PASS');}catch(error){await log('trial-'+trial+'-cleanup-failure.log',error.stack);primary=primary?new AggregateError([primary,error],'Diagnostic trial and cleanup failed'):error;}}
  if(primary)throw primary;
 }
}
const outcome=await executeSmokeOperation(async context=>{await operation({version:candidate.version,commitSha:candidate.candidateSha,manifestSha256:candidate.manifestSha256,manifest:path.resolve('diagnostics/manifest.json')},{...context,async check(name,detail,action){console.log('START '+name);return context.check(name,detail,async()=>{try{const result=await action();console.log('PASS '+name);return result;}catch(error){await log('failure-'+name+'.log',error.stack);console.error('FAIL '+name+'\n'+error.stack);throw error;}});},deferCleanup(name,detail,action){context.deferCleanup(name,detail,async()=>{await collectLogs();console.log('CLEANUP '+name);await action();console.log('CLEANUP PASS '+name);});},captureInstallation,async captureDockerImage(reference,digest){await log('docker-image-'+(++seq)+'.txt',JSON.stringify({diagnosticOnly:true,reference,digest}));}},{strictRunner,runDockerProbe:repeatDockerProbe});});
await log('outcome.txt',JSON.stringify({diagnosticOnly:true,lane,conclusion:outcome.conclusion,checks:outcome.checks,errors:outcome.errors.map(x=>x.stack)},null,2));
try { await strictRunner.runCommand('docker',['image','inspect','node:22-slim','--format','{{json .RepoDigests}} {{.Id}}'],{cwd:source,env:publicNpmEnvironment({home:output}),timeoutMs:60000,maxOutputBytes:1048576}); } catch(error) { await log('docker-image-inspection-error.txt',error.message); }
console.log('DIAGNOSTIC '+outcome.conclusion);if(outcome.conclusion!=='success')process.exitCode=1;
