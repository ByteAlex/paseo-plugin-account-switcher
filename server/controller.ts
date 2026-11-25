import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "./paseo-api";
import { AccountSchema, missingCli, type LoginSession, type Provider } from "../shared/contracts";
import { AccountStore, accountFrom, boundAccount, type Registry, type StoredAccount, type StoredBinding } from "./store";
import { prepareProfile } from "./profiles";
import { accountCommand, accountEnvironment, launchLogin, probeAccount, removeAccountCredentials } from "./auth";
import { installIntegration, restoreIntegration, writeLaunchers, prepareRuntime, reconcileIntegration } from "./integration";
import { SwitchRefusal, SwitchService } from "./switching";
import { createUsageService, readCredentialVersion, usageChecksEnabled, type AccountReadOptions, type QuotaAccount } from "./usage";
import { renewExpiredClaudeToken } from "./usage/claude";
import { LoginRefusal, LoginSessions, type LoginDependencies } from "./login";
import { receiptProcessRuns } from "./process-identity";

const execFileAsync=promisify(execFile);
// Paseo sets these for its own Node processes, this plugin's included, and removes them before it starts an outside
// command. Inherited, ELECTRON_RUN_AS_NODE makes an Electron executable, such as a `paseo` link to the desktop app's
// executable left by an older install, run as plain Node, which then fails to load "agent" as a script.
const RUNTIME_ENV=["PASEO_NODE_ENV","PASEO_DESKTOP_MANAGED","PASEO_SUPERVISED","ELECTRON_RUN_AS_NODE","ELECTRON_NO_ATTACH_CONSOLE","ESBUILD_BINARY_PATH"];
// PASEO_CLI names the desktop app's bundled CLI, for the daemon the app starts and for one started from the app's terminal,
// which inherits it and can outlive the app. A standalone daemon finds `paseo` on PATH.
function paseoCli(){const env={...process.env};for(const key of RUNTIME_ENV)delete env[key];return{command:process.env.PASEO_CLI?.trim()||"paseo",env};}
// A revoked sign-in fails every renewal; this bounds how often it starts the CLI.
const RENEWAL_INTERVAL=600000;
// A new agent's binding is written before its CLI starts, and Paseo reports no failed creation. This covers the time until the
// CLI reads the binding, where each plugin hook gets 30 seconds; from then on the launcher's receipt says whether that CLI still runs.
const CREATION_WAIT=600000;
// Deleted-agent reconciliation runs at most once per interval during UI polling, with bounded concurrency per bound agent
// instead of paginating every archived agent on the daemon. Explicit login/remove actions always force a fresh scoped pass.
const RECONCILE_INTERVAL=60_000;
const RECONCILE_CONCURRENCY=4;
const SNAPSHOT_RECONCILE_WAIT_MS=5_000;
const SNAPSHOT_CONFIRM_WAIT_MS=5_000;
// Bound each individual agent lookup, each forced login/remove reconciliation, and end-to-end RPC preparation so even
// cold-start ensureRuntime + forced checks + watchdog startup stay strictly under Paseo's 30s plugin RPC timeout.
const PROBE_TIMEOUT_MS=5_000;
const FORCE_RECONCILE_TIMEOUT_MS=8_000;
const RPC_BUDGET_MS=20_000;
// Pre-deletion verification + queue budget for remove() leaves 20s of headroom under Paseo's 30s RPC timeout
// for the 5s Keychain deletion, profile directory cleanup, and registry commit.
const REMOVE_START_BUDGET_MS=10_000;
type ProbeSignal={aborted:boolean;listeners?:Set<()=>void>};
function abortSignal(signal:ProbeSignal):void{
 if(signal.aborted)return;
 signal.aborted=true;
 const listeners=signal.listeners;
 signal.listeners=undefined;
 if(listeners)for(const listener of listeners)listener();
}
function raceTimeout<T>(promise:Promise<T>,ms:number,error:string|(()=>Error),signal?:ProbeSignal):Promise<T>{
 void promise.catch(()=>{});
 const makeError=()=>typeof error==="string"?new Error(error):error();
 if(signal?.aborted||ms<=0)return Promise.reject(makeError());
 let timer:ReturnType<typeof setTimeout>|undefined;
 let onAbort:(()=>void)|undefined;
 const cleanup=()=>{
  if(timer){clearTimeout(timer);timer=undefined;}
  if(onAbort&&signal?.listeners){signal.listeners.delete(onAbort);onAbort=undefined;}
 };
 return new Promise<T>((resolve,reject)=>{
  timer=setTimeout(()=>{cleanup();reject(makeError());},ms);
  timer.unref?.();
  if(signal){
   onAbort=()=>{cleanup();reject(makeError());};
   (signal.listeners??=new Set()).add(onAbort);
  }
  promise.then(
   value=>{cleanup();resolve(value);},
   err=>{cleanup();reject(err);},
  );
 });
}
type ProbeEntry={epoch:number;promise:Promise<boolean|undefined>;signal:ProbeSignal;callers:number;dispatched:boolean};
// Agent statuses that show a launch got under way, for the receipt check: the Accounts list waits for a session that is
// up. Failover also takes "error", which Paseo sets when a turn fails, before the plugin's turn_ended hook runs: the
// launcher wrote the receipt when it started the CLI, so the receipt still names the account the agent started on.
const STARTED=["idle","running"],STARTED_FOR_FAILOVER=[...STARTED,"error"];
export class AccountController {
 readonly store:AccountStore;
 readonly ready:Promise<void>;
 readonly usage:ReturnType<typeof createUsageService>;
 private readonly checks=new Map<string,Promise<StoredAccount>>();
 private readonly credentialVersions=new Map<string,string>();
 private readonly credentialProofs=new Map<string,{version:string;identityKey:string;generation:number}>();
 private readonly renewals=new Map<string,number>();
 private readonly switches=new Map<PaseoApi,SwitchService>();
 private readonly applying=new Set<string>();
 private runtimeReady:Promise<void>|undefined;
 private readonly integrationReconciles=new WeakMap<PaseoApi,Promise<void>>();
 private reconcileInFlight:Promise<void>|undefined;
 private loginReconcileInFlight:Promise<void>|undefined;
 private lastReconcileAt=-Infinity;
 private reconcileEpoch=0;
 private readonly agentProbes=new WeakMap<PaseoApi,Map<string,ProbeEntry>>();
 private activeProbes=0;
 private readonly probeWaiters:{resolve:(acquired:boolean)=>void;isAborted?:()=>boolean;allowDisposed?:boolean}[]=[];
 private readonly quotaFlights=new Map<string,Promise<QuotaAccount[]>>();
 private integrationChanging=false;
 private readonly startingLogins=new Set<string>();
 private disposed=false;
 private readonly logins:LoginSessions;
 constructor(root=join(process.env.PASEO_HOME||join(homedir(),".paseo"),"account-switcher"),loginDependencies:Omit<LoginDependencies,"finish">={}) {
  this.store=new AccountStore(root);
  this.logins=new LoginSessions({...loginDependencies,finish:(id,token,successful)=>this.completeBackgroundLogin(id,token,successful)});
  this.ready=this.store.initialize({claude:resolve(process.env.CLAUDE_CONFIG_DIR||join(homedir(),".claude")),codex:resolve(process.env.CODEX_HOME||join(homedir(),".codex"))}).then(async()=>{
   await writeLaunchers(this.store);
   // A crash during reload must not leave an unconfirmed account marked applied.
   await this.store.change(state=>{for(const b of state.bindings){if(b.status==="switching"){b.currentAccountId=null;b.launchToken=null;b.status="error";b.error="The account switch was interrupted. Account not confirmed; apply the account again.";}}});
  });
  this.usage=createUsageService({getAccounts:input=>this.quotaAccounts(input),cachePath:join(root,"usage-cache.json"),checksEnabled:()=>usageChecksEnabled(join(dirname(root),"config.json"))});
  void this.ready.then(()=>{if(!this.disposed)this.usage.start();}).catch(()=>{});
 }
 async ensureRuntime(paseo:PaseoApi,deadlineMs?:number){
  await this.ready;
  const checkDeadline=()=>{if(deadlineMs!==undefined&&Date.now()>=deadlineMs)throw new Error("Timed out verifying Paseo provider integration. Try again.");};
  checkDeadline();
  if(!this.runtimeReady){
   const prepare=deadlineMs===undefined?prepareRuntime(paseo,this.store):prepareRuntime(paseo,this.store,deadlineMs);
   this.runtimeReady=prepare.catch(error=>{this.runtimeReady=undefined;throw error;});
  }
  await (deadlineMs===undefined?this.runtimeReady:raceTimeout(this.runtimeReady,deadlineMs-Date.now(),"Timed out verifying Paseo provider integration. Try again."));
  checkDeadline();
  const existing=this.integrationReconciles.get(paseo);
  if(existing){
   await (deadlineMs===undefined?existing:raceTimeout(existing,deadlineMs-Date.now(),"Timed out verifying Paseo provider integration. Try again."));
   return;
  }
  const task=Promise.resolve().then(()=>deadlineMs===undefined?reconcileIntegration(paseo,this.store):reconcileIntegration(paseo,this.store,deadlineMs));
  this.integrationReconciles.set(paseo,task);
  try{
   await (deadlineMs===undefined?task:raceTimeout(task,deadlineMs-Date.now(),"Timed out verifying Paseo provider integration. Try again."));
  }finally{if(this.integrationReconciles.get(paseo)===task)this.integrationReconciles.delete(paseo);}
 }
 async snapshot(paseo:PaseoApi){
  const deadline=Date.now()+RPC_BUDGET_MS;
  await this.ensureRuntime(paseo,deadline);
  await this.reconcileDeletedAgents(paseo,{maxWaitMs:Math.min(SNAPSHOT_RECONCILE_WAIT_MS,Math.max(0,deadline-Date.now()))});
  await this.reconcileLogins(Math.min(SNAPSHOT_RECONCILE_WAIT_MS,Math.max(0,deadline-Date.now())));
  const state=await this.store.read();
  const unconfirmed=state.bindings.filter(binding=>state.integration.enabled&&!this.integrationChanging&&binding.currentAccountId===null&&binding.status==="ready"&&!!binding.launchAccountId&&!!binding.launchToken);
  const confirmBudget=Math.min(SNAPSHOT_CONFIRM_WAIT_MS,deadline-Date.now());
  if(unconfirmed.length&&confirmBudget>0){
   const confirmDeadline=Date.now()+confirmBudget;
   const confirmSignal:ProbeSignal={aborted:false};
   let timer:ReturnType<typeof setTimeout>|undefined;
   const workersRun=(async()=>{
    let cursor=0;
    const workers=Math.min(RECONCILE_CONCURRENCY,unconfirmed.length);
    await Promise.all(Array.from({length:workers},async()=>{
     while(!confirmSignal.aborted){
      const remaining=confirmDeadline-Date.now();
      if(remaining<=0){abortSignal(confirmSignal);this.drainAbortedWaiters();return;}
      const binding=unconfirmed[cursor++];
      if(!binding)return;
      await this.confirmLaunch(paseo,state,binding,STARTED,Math.min(PROBE_TIMEOUT_MS,remaining),confirmSignal);
     }
    }));
   })();
   void workersRun.catch(()=>{});
   try{
    await Promise.race([
     workersRun,
     new Promise<void>(resolve=>{timer=setTimeout(()=>{abortSignal(confirmSignal);this.drainAbortedWaiters();resolve();},confirmBudget);timer.unref?.();}),
    ]);
   }finally{if(timer)clearTimeout(timer);abortSignal(confirmSignal);this.drainAbortedWaiters();}
  }
  return this.store.snapshot();
 }
 /** Confirms that an agent runs on the account it was launched on: the launcher's receipt names that account and launch,
  * and the agent's status is one of `started`. True once the binding records it as the agent's account. */
 private async confirmLaunch(paseo:PaseoApi,state:Registry,binding:StoredBinding,started:readonly string[],timeoutMs=PROBE_TIMEOUT_MS,signal?:ProbeSignal):Promise<boolean>{
  if(!state.integration.enabled||this.integrationChanging||binding.currentAccountId!==null||binding.status!=="ready"||!binding.launchAccountId||!binding.launchToken||signal?.aborted)return false;
  try{
   const receipt=JSON.parse(await readFile(join(this.store.root,"receipts",encodeURIComponent(binding.agentId)+".json"),"utf8"));
   if(receipt.accountId!==binding.launchAccountId||receipt.launchToken!==binding.launchToken||signal?.aborted)return false;
   const live=await this.fetchAgentBounded(paseo,binding.agentId,timeoutMs,signal);
   if(!live||!started.includes(live.agent.status))return false;
   return await this.store.change(r=>{
    const b=r.bindings.find(b=>b.agentId===binding.agentId);
    if(r.integration.enabled&&!this.integrationChanging&&b&&b.launchToken===binding.launchToken&&b.launchAccountId===binding.launchAccountId&&b.currentAccountId===null&&b.status==="ready"){
     b.currentAccountId=binding.launchAccountId;
     b.launchToken=null;
     b.registrationObserved=true;
     // Advance epoch inside store.change before atomic rename publishes the confirmed binding so no forced pass can reuse an older null probe.
     this.reconcileEpoch++;
     return true;
    }
    return false;
   });
  }catch{/* The UI keeps the account unconfirmed until native startup succeeds. */return false;}
 }
 /** The account an agent runs on, for failover. A launch not confirmed yet is confirmed now by its receipt, the check
  * `snapshot` makes while the app polls: an agent started with no app open (a schedule, a heartbeat, `paseo run`) would
  * otherwise wait for that. Unlike `snapshot` it also accepts an agent a failed turn left in "error". Null when nothing
  * confirms one. `state` is the registry to take the binding from, the latest by default. */
 async accountOf(paseo:PaseoApi,agentId:string,provider:Provider,state?:Registry):Promise<string|null>{
  await this.ready;
  const registry=state??await this.store.read(),known=boundAccount(registry,agentId,provider);
  if(known)return known;
  const binding=registry.bindings.find(b=>b.agentId===agentId);
  return binding&&await this.confirmLaunch(paseo,registry,binding,STARTED_FOR_FAILOVER)?binding.launchAccountId:null;
 }
 async observeAgentRegistration(agentId:string){
  await this.ready;
  const changed=await this.store.change(r=>{
   const binding=r.bindings.find(b=>b.agentId===agentId);
   if(!binding||binding.registrationObserved)return false;
   binding.registrationObserved=true;
   // Advance epoch before registry rename publishes registrationObserved so concurrent forced passes cannot join older null probes.
   this.reconcileEpoch++;
   return true;
  });
  if(changed)this.lastReconcileAt=-Infinity;
 }
 private async acquireProbe(isAborted?:()=>boolean,priority=false,allowDisposed=false):Promise<boolean>{
  if((!allowDisposed&&this.disposed)||isAborted?.())return false;
  if(this.activeProbes<RECONCILE_CONCURRENCY){this.activeProbes++;return true;}
  return new Promise<boolean>(resolve=>{
   const waiter={resolve,isAborted,allowDisposed};
   if(priority)this.probeWaiters.unshift(waiter);else this.probeWaiters.push(waiter);
  });
 }
 private releaseProbe():void{
  while(this.probeWaiters.length){
   const next=this.probeWaiters.shift()!;
   if((!next.allowDisposed&&this.disposed)||next.isAborted?.()){next.resolve(false);continue;}
   next.resolve(true);
   return;
  }
  this.activeProbes--;
 }
 private drainAbortedWaiters():void{
  for(let i=this.probeWaiters.length-1;i>=0;i--){
   if((!this.probeWaiters[i].allowDisposed&&this.disposed)||this.probeWaiters[i].isAborted?.()){
    const [removed]=this.probeWaiters.splice(i,1);
    removed.resolve(false);
   }
  }
 }
 private async fetchAgentBounded(paseo:PaseoApi,agentId:string,timeoutMs=PROBE_TIMEOUT_MS,outerSignal?:ProbeSignal):Promise<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>|null>{
  if(timeoutMs<=0||outerSignal?.aborted)return null;
  const localSignal:ProbeSignal={aborted:false};
  const isAborted=()=>localSignal.aborted||!!outerSignal?.aborted;
  const attempt=(async()=>{
   const acquired=await this.acquireProbe(isAborted,false,true);
   if(!acquired)return null;
   if(isAborted()){this.releaseProbe();return null;}
   // Hold the semaphore slot until the underlying daemon request settles so local timeouts cannot flood the daemon.
   const raw=Promise.resolve().then(()=>paseo.agents.ref(agentId).refresh());
   void raw.then(()=>{this.releaseProbe();},()=>{this.releaseProbe();});
   return raw;
  })();
  try{
   return await raceTimeout(attempt,timeoutMs,"Timed out checking agent status.",outerSignal);
  }catch(error){
   abortSignal(localSignal);
   this.drainAbortedWaiters();
   throw error;
  }
 }
 private async probeAgent(paseo:PaseoApi,agentId:string,options:{signal?:ProbeSignal;priority?:boolean;minEpoch?:number;timeoutMs?:number}={}):Promise<boolean|undefined>{
  const timeoutMs=options.timeoutMs??PROBE_TIMEOUT_MS;
  if(this.disposed||options.signal?.aborted||timeoutMs<=0)return undefined;
  let map=this.agentProbes.get(paseo);
  if(!map){map=new Map();this.agentProbes.set(paseo,map);}
  const existing=map.get(agentId);
  // Only reuse an active in-flight probe started at or after the caller's registration epoch so a stale pre-registration null
  // can never be consumed by a forced pass started after observeAgentRegistration() or confirmLaunch().
  let entry=existing&&!existing.signal.aborted&&(options.minEpoch===undefined||existing.epoch>=options.minEpoch)?existing:undefined;
  if(!entry){
   const probeEpoch=this.store.registrationEpoch;
   const entrySignal:ProbeSignal={aborted:false};
   let created!:ProbeEntry;
   const promise=Promise.resolve().then(async()=>{
    try{
     const acquired=await this.acquireProbe(()=>entrySignal.aborted,options.priority);
     if(!acquired)return undefined;
     // Hold the semaphore slot until the real daemon request finishes so local timeouts never exceed RECONCILE_CONCURRENCY in flight.
     try{
      if(this.disposed||entrySignal.aborted)return undefined;
      created.dispatched=true;
      return await Promise.resolve().then(()=>paseo.agents.ref(agentId).refresh()).then(found=>!!found,()=>undefined);
     }finally{this.releaseProbe();}
    }finally{if(map.get(agentId)===created)map.delete(agentId);}
   });
   created={epoch:probeEpoch,promise,signal:entrySignal,callers:0,dispatched:false};
   map.set(agentId,created);
   entry=created;
  }
  entry.callers++;
  try{
   return await raceTimeout(entry.promise,timeoutMs,"Timed out checking agent status.",options.signal);
  }catch{
   return undefined;
  }finally{
   entry.callers--;
   if(entry.callers===0&&!entry.dispatched){
    abortSignal(entry.signal);
    if(map.get(agentId)===entry)map.delete(agentId);
    this.drainAbortedWaiters();
   }
  }
 }
 private async reconcileDeletedAgents(paseo:PaseoApi,options:{force?:boolean;accountId?:string;maxWaitMs?:number}={}):Promise<void>{
  if(this.disposed)return;
  if(options.force){
   // Explicit login/remove actions check only the bindings referencing the target account so they never queue behind a slow full poll,
   // and fail closed before Paseo's 30s RPC timeout so an expired request cannot mutate account state after the caller saw a timeout.
   const budget=options.maxWaitMs===undefined?FORCE_RECONCILE_TIMEOUT_MS:Math.min(FORCE_RECONCILE_TIMEOUT_MS,options.maxWaitMs);
   if(budget<=0)throw new Error("Could not verify whether agents still use this account in time. Try again.");
   const signal:ProbeSignal={aborted:false};
   const deadline=Date.now()+budget;
   try{
    await raceTimeout(this.runReconcileDeletedAgents(paseo,options.accountId,signal,true,deadline),budget,"Could not verify whether agents still use this account in time. Try again.");
   }catch(error){abortSignal(signal);this.drainAbortedWaiters();throw error;}
   return;
  }
  const elapsed=Date.now()-this.lastReconcileAt;
  if(!this.reconcileInFlight&&elapsed>=0&&elapsed<RECONCILE_INTERVAL)return;
  let task=this.reconcileInFlight;
  if(!task){
   const epoch=this.reconcileEpoch;
   let run!:Promise<void>;
   run=Promise.resolve().then(async()=>{
    try{
     if(this.disposed)return;
     await this.runReconcileDeletedAgents(paseo);
     if(!this.disposed&&this.reconcileEpoch===epoch)this.lastReconcileAt=Date.now();
    }finally{if(this.reconcileInFlight===run)this.reconcileInFlight=undefined;}
   });
   this.reconcileInFlight=run;
   task=run;
  }
  if(options.maxWaitMs===undefined){await task;return;}
  // A slow reconciliation may outlive a single snapshot poll; keep it attached so a late rejection never crashes the subprocess.
  void task.catch(()=>{});
  if(options.maxWaitMs<=0)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([task,new Promise<void>(resolve=>{timer=setTimeout(resolve,options.maxWaitMs);timer.unref?.();})]);
  }finally{if(timer)clearTimeout(timer);}
 }
 private async runReconcileDeletedAgents(paseo:PaseoApi,accountId?:string,signal?:ProbeSignal,priority=false,deadlineMs?:number):Promise<void>{
  const before=await this.store.read();
  if(!before.bindings.length||this.disposed||signal?.aborted||typeof paseo?.agents?.ref!=="function")return;
  const scoped=accountId?before.bindings.filter(b=>b.currentAccountId===accountId||b.pendingAccountId===accountId||b.launchAccountId===accountId):before.bindings;
  if(!scoped.length)return;
  const minEpoch=this.store.registrationEpoch;
  const captured=new Map(scoped.map(binding=>[binding.agentId,JSON.stringify(binding)]));
  const now=Date.now(),existing=new Set<string>(),needsObserve=new Set<string>(),gone=new Set<string>();
  const candidates=scoped.filter(binding=>!this.applying.has(binding.agentId)&&binding.status!=="switching");
  let cursor=0;
  const workers=Math.min(RECONCILE_CONCURRENCY,candidates.length);
  await Promise.all(Array.from({length:workers},async()=>{
   while(!this.disposed&&!signal?.aborted){
    const binding=candidates[cursor++];
    if(!binding)return;
    const timeoutMs=deadlineMs===undefined?PROBE_TIMEOUT_MS:Math.min(PROBE_TIMEOUT_MS,deadlineMs-Date.now());
    if(timeoutMs<=0)return;
    // Query only the bound agents directly (deduplicated per registration epoch and globally concurrency-capped across passes).
    const known=await this.probeAgent(paseo,binding.agentId,{signal,priority,minEpoch,timeoutMs});
    if(this.disposed||signal?.aborted)return;
    if(known){
     existing.add(binding.agentId);
     if(!binding.registrationObserved)needsObserve.add(binding.agentId);
    }else if(known===false){
     if(binding.registrationObserved||binding.currentAccountId!==null||await this.creationOver(binding,now))gone.add(binding.agentId);
    }
   }
  }));
  if(this.disposed||signal?.aborted)return;
  const needsBoundAt=scoped.some(binding=>!binding.registrationObserved&&binding.currentAccountId===null&&!binding.boundAt);
  if(!needsObserve.size&&!gone.size&&!needsBoundAt)return;
  await this.store.change(r=>{
   if(this.disposed||signal?.aborted)return;
   r.bindings=r.bindings.filter(binding=>{
    if(existing.has(binding.agentId)){binding.registrationObserved=true;return true;}
    if(captured.get(binding.agentId)!==JSON.stringify(binding)||this.applying.has(binding.agentId)||binding.status==="switching")return true;
    if(gone.has(binding.agentId))return false;
    // session_open runs before native creation/registration, so a new agent's binding that has never appeared in Paseo
    // may belong to a creation still under way. A binding from before 0.9 starts its wait here.
    if(!binding.registrationObserved&&binding.currentAccountId===null)binding.boundAt??=new Date(now).toISOString();
    return true;
   });
  });
 }
 /** Whether a new agent's creation can no longer use its profile: the wait is over and no CLI of its launch still runs.
  * A profile that may be in use is not released, so anything unclear about the receipt keeps the binding. */
 private async creationOver(binding:StoredBinding,now:number):Promise<boolean>{
  if(!binding.boundAt||now-Date.parse(binding.boundAt)<CREATION_WAIT)return false;
  let pid:unknown,at:unknown;
  try{({pid,at}=JSON.parse(await readFile(join(this.store.root,"receipts",encodeURIComponent(binding.agentId)+".json"),"utf8")));}
  catch(error){return (error as NodeJS.ErrnoException).code==="ENOENT";}
  if(typeof pid!=="number"||!Number.isInteger(pid)||pid<=0)return false;
  return !await receiptProcessRuns(pid,at);
 }
 async setDefault(provider:Provider,id:string|null){
  await this.ready;
  if(id===null){await this.store.change(r=>{r.defaults[provider]=null;});return;}
  const before=await this.store.read(),account=accountFrom(before,id);
  if(account.provider!==provider)throw new Error("The account belongs to another provider.");
  if(account.loginToken)throw new Error("Account sign-in is still in progress.");
  const checked=await this.checkAccount(id);
  if(checked.authStatus!=="ready")throw new Error("Sign in and verify authentication before making this the default account.");
  await this.store.change(r=>{const current=accountFrom(r,id);if(r.defaults[provider]!==before.defaults[provider])throw new Error("The default account changed; select it again.");if(current.loginToken||current.generation!==checked.generation||current.authStatus!=="ready")throw new Error("Account authentication changed; check sign-in again.");r.defaults[provider]=id;});
 }
 async checkAccount(id:string,verifyCredentials=false):Promise<StoredAccount> {
  await this.ready;
  const existing=this.checks.get(id);
  if(existing){if(!verifyCredentials)return existing;await existing.catch(()=>{});return this.checkAccount(id,true);}
  const task=(async()=>{
   const state=await this.store.read(), account=accountFrom(state,id);
   if(!state.available[account.provider])throw new Error(missingCli(account.provider));
   if(account.loginToken)throw new Error("Finish signing in, then click “Check sign-in”.");
   let identity:Awaited<ReturnType<typeof probeAccount>>;
   let stableVersion:string|undefined;
   if(verifyCredentials){
    this.credentialProofs.delete(id);
    const quota=this.toQuotaAccount(account,state);
    // An idle account's token expires with no CLI running to renew it. Renew before the proof, so it covers the new token.
    if(account.provider==="claude"&&Date.now()-(this.renewals.get(id)??-Infinity)>=RENEWAL_INTERVAL&&await renewExpiredClaudeToken(quota)){this.renewals.set(id,Date.now());console.log(`Asked the Claude CLI to renew the expired access token of account ${id}.`);}
    for(let attempt=0;;attempt++){
     const before=await readCredentialVersion(quota);
     identity=await probeAccount(account,state);
     const after=await readCredentialVersion(quota);
     if(after!=="unavailable")this.credentialVersions.set(id,after);
     if(before===after&&after.startsWith("present:")){stableVersion=after;break;}
     if(attempt===1||before==="unavailable"||after==="unavailable")break;
    }
   }else identity=await probeAccount(account,state);
   // A transient CLI failure cannot change identity or discard the last quota.
   const updated=await this.store.updateIdentity(id,identity.authStatus==="error"?{identityKey:account.identityKey,email:account.email,plan:account.plan,authStatus:"error"}:identity,account);
   if(stableVersion&&identity.authStatus==="ready"&&identity.identityKey&&updated.authStatus==="ready"&&updated.identityKey===identity.identityKey&&!updated.loginToken)this.credentialProofs.set(id,{version:stableVersion,identityKey:identity.identityKey,generation:updated.generation});
   if(updated.generation!==account.generation&&!verifyCredentials)await this.usage.invalidate(id);
   return updated;
  })();
  this.checks.set(id,task);
  try{return await task;}finally{if(this.checks.get(id)===task)this.checks.delete(id);}
 }
 async quotaAccounts(input:AccountReadOptions={}):Promise<QuotaAccount[]> {
  const key=input.verifyAccountId??"";
  const existing=this.quotaFlights.get(key);if(existing)return existing;
  const task=this.readQuotaAccounts(input);this.quotaFlights.set(key,task);
  try{return await task;}finally{if(this.quotaFlights.get(key)===task)this.quotaFlights.delete(key);}
 }
 private async readQuotaAccounts(input:AccountReadOptions):Promise<QuotaAccount[]> {
  await this.ready;
  await this.reconcileLogins();
  const initial=await this.store.read();
  const target=initial.accounts.find(account=>account.id===input.verifyAccountId);
  if(target&&initial.available[target.provider]&&initial.commands[target.provider]&&!target.loginToken)await this.checkAccount(target.id,true).catch(()=>{this.credentialProofs.delete(target.id);});
  const state=await this.store.read();
  return state.accounts.filter(a=>state.available[a.provider]&&state.commands[a.provider]&&!a.loginToken).map(account=>this.toQuotaAccount(account,state));
 }
 private toQuotaAccount(account:StoredAccount,state:Registry):QuotaAccount {
   const env=accountEnvironment(account,state);
   const credentialHome=account.provider==="claude"?(env.CLAUDE_SECURESTORAGE_CONFIG_DIR??env.CLAUDE_CONFIG_DIR)||join(env.HOME||homedir(),".claude"):account.home;
   const quota:QuotaAccount={id:account.id,provider:account.provider,home:credentialHome,identityKey:account.identityKey,generation:account.generation,command:accountCommand(state,account.provider),env,requireIdentityVerification:account.identityKey!==null};
   quota.credentialVersion=this.credentialVersions.get(account.id);
   const proof=this.credentialProofs.get(account.id);
   if(account.authStatus==="ready"&&proof?.identityKey===account.identityKey&&proof?.generation===account.generation)quota.identityCredentialVersion=proof.version;
   return quota;
 }
 async add(provider:Provider,label:string) {
  await this.ready;
  if(!(await this.store.read()).available[provider])throw new Error(missingCli(provider));
  const account=await this.store.add(provider,label);
  try{const state=await this.store.read();await prepareProfile({provider,home:account.home,sourceHome:state.sourceHomes[provider],sourceEnvironment:state.sourceEnvironment[provider]});return AccountSchema.parse(account);}
  catch(error){await this.store.remove(account.id,async()=>{await rm(dirname(account.home),{recursive:true,force:true});});throw error;}
 }
 async login(paseo:PaseoApi,id:string,workspaceId?:string,mode?:"device"|"browser",deadlineMs=Date.now()+RPC_BUDGET_MS) {
  await this.ready;
  await this.reconcileDeletedAgents(paseo,{force:true,accountId:id,maxWaitMs:deadlineMs-Date.now()});
  if(Date.now()>=deadlineMs)throw new Error("Account sign-in took too long to prepare. Try again.");
  if(this.startingLogins.has(id))throw new Error("Sign-in is already being prepared.");
  const token=randomUUID();
  this.startingLogins.add(id);
  try{
   await raceTimeout(
    this.store.change(state=>{if(Date.now()>=deadlineMs)throw new Error("Account sign-in took too long to prepare. Try again.");const account=accountFrom(state,id);if(account.source!=="managed")throw new Error("Add a separate account for isolated sign-in.");if(account.loginToken)throw new Error("Sign-in is already open. Continue in the Paseo terminal.");if(state.bindings.some(b=>b.currentAccountId===id||b.launchAccountId===id||b.currentAccountId===null&&b.pendingAccountId===id))throw new Error("Switch agents away from this account before signing in again.");account.loginToken=token;account.login=null;}),
    deadlineMs-Date.now(),
    "Account sign-in took too long to prepare. Try again.",
   );
   this.usage.invalidate(id);
   // A status probe started before the reservation must finish before the CLI
   // can replace credentials. Completion then always probes the new identity.
   const existingCheck=this.checks.get(id);
   if(existingCheck)await raceTimeout(existingCheck.catch(()=>{}),Math.min(PROBE_TIMEOUT_MS,deadlineMs-Date.now()),"An account check is still in progress. Try signing in again shortly.");
   if(Date.now()>=deadlineMs)throw new Error("Account sign-in took too long to prepare. Try again.");
   const session=await launchLogin(paseo,this.store,id,workspaceId,mode);
   await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===token)a.login=session;});
   return session;
  }catch(error){
   const clear=this.store.change(r=>{const a=r.accounts.find(a=>a.id===id);if(a?.loginToken===token){a.loginToken=null;a.login=null;}});
   void clear.catch(()=>{});
   const remaining=deadlineMs-Date.now();
   if(remaining>0)await raceTimeout(clear,remaining,"Account sign-in took too long to prepare. Try again.").catch(()=>{});
   throw error;
  }
  finally{this.startingLogins.delete(id);}
 }
 async startLogin(paseo:PaseoApi,id:string,mode:"device"|"browser"="device",deadlineMs=Date.now()+RPC_BUDGET_MS):Promise<LoginSession>{
  await this.ready;
  if(this.disposed)throw new Error("Account sign-in is shutting down. Try again shortly.");
  await this.reconcileDeletedAgents(paseo,{force:true,accountId:id,maxWaitMs:deadlineMs-Date.now()});
  if(Date.now()>=deadlineMs)throw new Error("Account sign-in took too long to prepare. Try again.");
  if(this.startingLogins.has(id))throw new Error("Sign-in is already being prepared.");
  this.startingLogins.add(id);
  const token=randomUUID();
  try{
   const registry=await this.store.read(),account=accountFrom(registry,id);
   if(account.loginToken)throw new Error("Sign-in is already open. Continue or cancel the current attempt.");
   if(account.source!=="managed")throw new Error("Add a separate account for isolated sign-in.");
   return await this.logins.start(account,registry,this.store.root,token,mode,async()=>{
    if(Date.now()>=deadlineMs)throw new LoginRefusal("Account sign-in took too long to prepare. Try again.");
    await raceTimeout(
     this.store.change(state=>{if(Date.now()>=deadlineMs)throw new LoginRefusal("Account sign-in took too long to prepare. Try again.");const current=accountFrom(state,id);if(current.loginToken)throw new LoginRefusal("Sign-in is already open. Continue or cancel the current attempt.");if(state.bindings.some(b=>b.currentAccountId===id||b.launchAccountId===id||b.currentAccountId===null&&b.pendingAccountId===id))throw new LoginRefusal("Switch agents away from this account before signing in again.");current.loginToken=token;current.login={sessionId:token,mode:account.provider==="claude"?"browser":mode};}),
     deadlineMs-Date.now(),
     ()=>new LoginRefusal("Account sign-in took too long to prepare. Try again."),
    );
    this.usage.invalidate(id);
    const existingCheck=this.checks.get(id);
    if(existingCheck)await raceTimeout(existingCheck.catch(()=>{}),Math.min(PROBE_TIMEOUT_MS,deadlineMs-Date.now()),()=>new LoginRefusal("An account check is still in progress. Try signing in again shortly."));
    if(Date.now()>=deadlineMs)throw new LoginRefusal("Account sign-in took too long to prepare. Try again.");
   });
  }catch(error){
   // LoginSessions stops its already-established watchdog before rejecting.
   // Clear only our reservation, never a newer attempt; bound waiting on a stalled store.queue by the remaining RPC deadline.
   if(!this.logins.has(id,token)){
    const clear=this.store.change(r=>{const account=r.accounts.find(a=>a.id===id);if(account?.loginToken===token){account.loginToken=null;account.login=null;}});
    void clear.catch(()=>{});
    const remaining=deadlineMs-Date.now();
    if(remaining>0)await raceTimeout(clear,remaining,"Account sign-in took too long to prepare. Try again.").catch(()=>{});
   }
   throw error;
  }finally{this.startingLogins.delete(id);}
 }
 private async completeBackgroundLogin(id:string,token:string,successful:boolean):Promise<boolean>{
  const cleared=await this.store.change(state=>{const account=accountFrom(state,id);if(account.loginToken!==token)return false;account.loginToken=null;account.login=null;return true;});
  if(!cleared)return false;
  const account=await this.checkAccount(id);
  void this.usage.refresh(id).catch(()=>{});
  return successful&&account.authStatus==="ready"&&!account.loginToken;
 }
 async getLoginStatus(id:string,sessionId:string):Promise<LoginSession>{
  await this.ready;
  if(this.logins.has(id,sessionId))return this.logins.status(id,sessionId);
  const account=accountFrom(await this.store.read(),id);
  if(!account.login||!("sessionId" in account.login)||account.login.sessionId!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  let completed=false;
  try{const receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));if(receipt.loginToken===sessionId){const checked=await this.finishLogin(id);completed=receipt.exitCode===0&&checked.authStatus==="ready";}}catch{/* The watchdog must confirm exit before releasing the reservation. */}
  return{id:sessionId,accountId:id,provider:account.provider,mode:account.login.mode,status:completed?"complete":"error",authorizationUrl:null,userCode:null,canSubmitCode:false,expiresAt:null,error:completed?null:"Sign-in was interrupted. Cancel this attempt, then start sign-in again."};
 }
 async submitLoginCode(id:string,sessionId:string,code:string):Promise<LoginSession>{
  await this.ready;
  if(accountFrom(await this.store.read(),id).loginToken!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  return this.logins.submit(id,sessionId,code);
 }
 async cancelLogin(paseo:PaseoApi,id:string,sessionId?:string){
  await this.ready;
  if(this.startingLogins.has(id))throw new Error("The sign-in terminal is still being prepared. Try again shortly.");
  const account=accountFrom(await this.store.read(),id),token=account.loginToken;
  if(sessionId&&token!==sessionId)throw new Error("This sign-in attempt is no longer active. Start sign-in again.");
  if(!token)return AccountSchema.parse(await this.checkAccount(id));
  if(account.login&&"sessionId" in account.login){
   if(!sessionId)throw new Error("Select the current sign-in attempt before canceling it.");
   if(this.logins.has(id,token))await this.logins.cancel(id,token);
   else{
    let receipt;try{receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));}catch{throw new Error("The previous sign-in is still stopping. Try canceling again shortly.");}
    if(receipt.loginToken!==token)throw new Error("The previous sign-in is still stopping. Try canceling again shortly.");
   }
   await this.store.change(r=>{const current=accountFrom(r,id);if(current.loginToken===token){current.loginToken=null;current.login=null;}});
   this.usage.invalidate(id);return AccountSchema.parse(await this.checkAccount(id));
  }
  const terminals=account.login&&"terminalId" in account.login?[account.login.terminalId]:(await paseo.terminals.list({cwd:join(this.store.root,"login",id)})).entries.map(t=>t.id);
  for(const terminalId of terminals){const terminal=paseo.terminals.ref(terminalId);if(await terminal.refresh())await terminal.kill();}
  await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===token){a.loginToken=null;a.login=null;}});
  this.usage.invalidate(id);
  return AccountSchema.parse(await this.checkAccount(id));
 }
 private async reconcileLogins(maxWaitMs?:number){
  let task=this.loginReconcileInFlight;
  if(!task){
   let run!:Promise<void>;
   run=Promise.resolve().then(async()=>{
    try{
     const state=await this.store.read();
     for(const account of state.accounts.filter(a=>a.loginToken)){
      if(account.login&&"sessionId" in account.login&&this.logins.has(account.id,account.login.sessionId))continue;
      try{
       const receipt=JSON.parse(await readFile(join(this.store.root,"logins",account.id+".json"),"utf8"));
       if(receipt.loginToken===account.loginToken)await this.finishLogin(account.id);
      }catch{/* Pending login remains reserved; the UI can still check explicitly. */}
     }
    }finally{if(this.loginReconcileInFlight===run)this.loginReconcileInFlight=undefined;}
   });
   this.loginReconcileInFlight=run;
   task=run;
  }
  if(maxWaitMs===undefined){await task;return;}
  void task.catch(()=>{});
  if(maxWaitMs<=0)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([task,new Promise<void>(resolve=>{timer=setTimeout(resolve,maxWaitMs);timer.unref?.();})]);
  }finally{if(timer)clearTimeout(timer);}
 }
 async finishLogin(id:string) {
  const before=accountFrom(await this.store.read(),id);
  if(before.login&&"sessionId" in before.login&&this.logins.has(id,before.login.sessionId))throw new Error("Sign-in is still in progress. Continue in the sign-in dialog.");
  if(before.loginToken){
   let receipt;try{receipt=JSON.parse(await readFile(join(this.store.root,"logins",id+".json"),"utf8"));}catch{throw new Error("Sign-in in the terminal has not finished yet.");}
   if(receipt.loginToken!==before.loginToken)throw new Error("Sign-in in the terminal has not finished yet.");
   await this.store.change(r=>{const a=accountFrom(r,id);if(a.loginToken===before.loginToken){a.loginToken=null;a.login=null;}});
  }
  const account=await this.checkAccount(id);
  void this.usage.refresh(id).catch(()=>{});
  return AccountSchema.parse(account);
 }
 async remove(id:string,paseo?:PaseoApi,deadlineMs=Date.now()+REMOVE_START_BUDGET_MS) {
  await this.ready;
  const startDeadline=Math.min(deadlineMs,Date.now()+REMOVE_START_BUDGET_MS);
  if(paseo){
   await this.reconcileDeletedAgents(paseo,{force:true,accountId:id,maxWaitMs:startDeadline-Date.now()});
   if(Date.now()>=startDeadline)throw new Error("Could not verify whether agents still use this account in time. Try again.");
  }
  const account=accountFrom(await this.store.read(),id);
  let deletionStarted=false;
  let cancelTimer:(()=>void)|undefined;
  const removeTask=this.store.remove(id,async(account,state)=>{
   if(Date.now()>=startDeadline)throw new Error("Could not verify whether agents still use this account in time. Try again.");
   if(account.loginToken)throw new Error("Finish signing in in the terminal first.");
   if(!/^[A-Za-z0-9_-]+$/.test(id)||resolve(account.home)!==join(this.store.root,"accounts",id,account.provider))throw new Error("Invalid profile path.");
   const root=await realpath(this.store.root),paths:string[]=[];
   for(const [directory,name] of [["accounts",id],["login",id],["logins",`${id}.json`]]){
    const parent=join(this.store.root,directory);
    try{if(!(await lstat(parent)).isDirectory()||await realpath(parent)!==join(root,directory))throw new Error("The plugin directory has been redirected; cleanup was refused.");paths.push(join(parent,name));}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   }
   if(Date.now()>=startDeadline)throw new Error("Could not verify whether agents still use this account in time. Try again.");
   // Once credential deletion begins, cancel the pre-deletion queue deadline so remove() never reports a verification timeout while deleting.
   deletionStarted=true;
   cancelTimer?.();
   await removeAccountCredentials(account,state);
   for(const path of paths)await rm(path,{recursive:true,force:true});
  });
  await new Promise<void>((resolvePromise,rejectPromise)=>{
   let settled=false;
   const finish=(fn:()=>void)=>{if(settled)return;settled=true;cancelTimer?.();fn();};
   const remaining=startDeadline-Date.now();
   if(remaining<=0){void removeTask.catch(()=>{});finish(()=>rejectPromise(new Error("Could not verify whether agents still use this account in time. Try again.")));return;}
   const timer=setTimeout(()=>{if(deletionStarted)return;void removeTask.catch(()=>{});finish(()=>rejectPromise(new Error("Could not verify whether agents still use this account in time. Try again.")));},remaining);
   timer.unref?.();
   cancelTimer=()=>{clearTimeout(timer);};
   removeTask.then(()=>finish(()=>resolvePromise()),error=>finish(()=>rejectPromise(error)));
  });
  await this.usage.invalidate(id);
  this.credentialVersions.delete(account.id);this.credentialProofs.delete(account.id);this.renewals.delete(account.id);
 }
 async integration(paseo:PaseoApi,enabled:boolean,deadlineMs=Date.now()+RPC_BUDGET_MS) {
  await this.ready;
  if(this.applying.size||this.integrationChanging)throw new Error("Wait for the integration or account change to finish.");
  this.integrationChanging=true;
  try{
   if(enabled)await installIntegration(paseo,this.store,deadlineMs);
   else await restoreIntegration(paseo,this.store,deadlineMs);
   return this.store.snapshot();
  }finally{this.integrationChanging=false;}
 }
 switcher(paseo:PaseoApi):SwitchService {
  let service=this.switches.get(paseo);if(service)return service;
  const requireIntegration=async()=>{if(this.integrationChanging)throw new SwitchRefusal("An integration change is still in progress.");await reconcileIntegration(paseo,this.store);if(!(await this.store.read()).integration.enabled)throw new SwitchRefusal("Account integration is no longer active. Check its settings and enable it again.");};
  service=new SwitchService({store:this.store,applying:this.applying,usage:()=>this.usage.list(),checkAccount:async id=>{await requireIntegration();return this.checkAccount(id);},inspect:async(id)=>{
   const result=await paseo.agents.ref(id).refresh();if(!result)throw new SwitchRefusal("Agent not found.");
   const a=result.agent;
   return{provider:a.provider,busy:a.status==="running"||a.status==="initializing"||!!a.activeTurn||a.pendingPermissions.length>0,archived:!!a.archivedAt};
  },reload:async(id)=>{
   await requireIntegration();
   const agent=paseo.agents.ref(id) as {reload?:()=>Promise<unknown>;commands?:()=>Promise<unknown>};
   // From Paseo 0.14 the SDK sends the request the CLI would, with no process to start and no daemon address to find.
   if(agent.reload){
    try{await agent.reload();}
    catch(error){
     console.error(`Native reload of agent ${id} failed: ${stripVTControlCharacters(error instanceof Error?error.message:String(error)).replace(/\s+/g," ").trim().slice(0,500)||"no output"}`);
     throw new SwitchRefusal("The native agent reload failed. Check the agent status and try again.");
    }
   }else{
    const config=JSON.parse(await readFile(join(dirname(this.store.root),"config.json"),"utf8"));
    const listen=config.daemon?.listen;
    if(typeof listen!=="string"||!listen)throw new SwitchRefusal("Could not identify the daemon for reload.");
    const host=listen.replace(/^0\.0\.0\.0:/,"127.0.0.1:");
    const cli=paseoCli();let command=cli.command;
    const reload=(file:string)=>execFileAsync(file,["agent","reload",id,"--json","--host",host],{timeout:120_000,maxBuffer:1024*1024,env:cli.env});
    try{
     // A CLI that could not start reloaded nothing, so `paseo` on PATH can still try. One that ran and failed is not repeated.
     await reload(command).catch(error=>{const code=(error as {code?:unknown}).code;if(command==="paseo"||(code!=="ENOENT"&&code!=="EACCES"))throw error;command="paseo";return reload(command);});
    }
    catch(error){
     // The chat gets the refusal; the cause, which can name local paths, goes only to the plugin log.
     const {code,signal,stderr}=error as {code?:unknown;signal?:unknown;stderr?:unknown};
     console.error(`Native reload of agent ${id} with ${command} failed (${signal?`signal ${signal}`:`code ${code}`}): ${stripVTControlCharacters(String(stderr??"")).replace(/\s+/g," ").trim().slice(0,500)||"no output"}`);
     throw new SwitchRefusal("The native agent reload failed. Check the agent status and try again.");
    }
   }
   // Paseo 0.11 reloads into an idle session and spawns the CLI on first use; listing
   // commands starts it so the launcher can confirm the account. Older hosts already started it.
   if(agent.commands)await agent.commands().catch(()=>{/* The receipt check reports a failed start. */});
  }});
  this.switches.set(paseo,service);return service;
 }
 async close(){this.disposed=true;this.drainAbortedWaiters();await this.logins.close();await this.usage.close();}
}
