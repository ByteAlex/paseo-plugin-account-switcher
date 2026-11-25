import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { PaseoApi } from "./paseo-api";
import type { Provider } from "../shared/contracts";
import type { AccountStore, Registry } from "./store";
import { atomicWrite } from "./files";
import { LAUNCHER_SOURCE } from "./launcher-artifact";
import { assertSubscriptionEnvironment } from "./profiles";

const providers = ["claude", "codex"] as const;
const COMMAND_DRIFT = "Provider commands changed outside the plugin. Enable integration again to apply accounts.";
// Each config.get() attempt stays short so even a cold start (discover + reconcile) plus a forced lookup fits under Paseo's 30s RPC timeout.
const CONFIG_GET_TIMEOUT_MS = 4_000;
const CONFIG_PATCH_TIMEOUT_MS = 10_000;
const INTEGRATION_WAIT_TIMEOUT_MS = 4_000;
class IntegrationBusyError extends Error {}
// Monotonic per-store counter bumped only when install/restore commits, plus in-flight patch tracking so a concurrent
// reconcileIntegration/prepareRuntime neither clears launch tokens mid-install nor skips fail-closed checks if install fails.
const integrationEpochs = new WeakMap<AccountStore, number>();
const integrationMutations = new WeakMap<AccountStore, Set<Promise<void>>>();
const currentEpoch = (store: AccountStore): number => integrationEpochs.get(store) ?? 0;
const bumpEpoch = (store: AccountStore): void => { integrationEpochs.set(store, currentEpoch(store) + 1); };
async function waitForIntegrationMutation(store: AccountStore, deadlineMs?: number): Promise<void> {
  const limit = deadlineMs ?? (Date.now() + INTEGRATION_WAIT_TIMEOUT_MS);
  while (true) {
    const pending = integrationMutations.get(store);
    if (!pending || !pending.size) return;
    const remaining = Math.min(INTEGRATION_WAIT_TIMEOUT_MS, limit - Date.now());
    if (remaining <= 0) throw new IntegrationBusyError("An integration change is still in progress. Try again shortly.");
    await withTimeout(
      Promise.all([...pending]),
      remaining,
      "An integration change is still in progress. Try again shortly.",
      () => new IntegrationBusyError("An integration change is still in progress. Try again shortly."),
    );
  }
}
async function trackIntegrationMutation<T>(store: AccountStore, run: (holdUntil: (promise: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let pending = integrationMutations.get(store);
  if (!pending) { pending = new Set(); integrationMutations.set(store, pending); }
  pending.add(gate);
  const trailing: Promise<unknown>[] = [];
  const holdUntil = (promise: Promise<unknown>) => { trailing.push(promise.then(() => {}, () => {})); };
  try { return await run(holdUntil); }
  finally {
    const release = () => {
      finish();
      pending!.delete(gate);
      if (!pending!.size && integrationMutations.get(store) === pending) integrationMutations.delete(store);
    };
    if (trailing.length) void Promise.all(trailing).then(release);
    else release();
  }
}
export const NO_PROVIDER_CLI = "Provider CLI not found. Install Claude Code or Codex, or configure its command in Paseo.";
export const launcherPath = (root: string, provider: Provider): string => join(root, "bin", `${provider}-launcher`);
/** The launcher bundle that every provider's launcher runs. */
export const launcherScriptPath = (root: string): string => join(root, "bin", "launcher.js");

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A provider's launcher: a shell script that runs the bundle with the Node that runs this plugin, and names the
 * provider. The bundle used to be the launcher itself, behind `#!/usr/bin/env node`, which takes the first `node` on the
 * agent's PATH; a project that pins an old Node through mise, asdf or nvm put that one first, and it could not parse the
 * bundle (#58). Under the desktop app the plugin's Node is Paseo's Electron, which acts as Node only with
 * ELECTRON_RUN_AS_NODE; the launcher drops the variable again before it starts the provider CLI.
 */
export function launcherWrapper(node: string, script: string, provider: Provider, electron: boolean): string {
  const lines = ["#!/bin/sh", `# Account Switcher ${provider} launcher, written by the plugin at every start. Do not edit.`];
  if (electron) lines.push("ELECTRON_RUN_AS_NODE=1; ACCOUNT_SWITCHER_ELECTRON=1; export ELECTRON_RUN_AS_NODE ACCOUNT_SWITCHER_ELECTRON");
  lines.push(`exec ${shellQuote(node)} ${shellQuote(script)} ${provider} "$@"`);
  return `${lines.join("\n")}\n`;
}

export async function writeLaunchers(store: AccountStore): Promise<void> {
  const script = launcherScriptPath(store.root);
  await atomicWrite(script, LAUNCHER_SOURCE, 0o600);
  const electron = typeof process.versions.electron === "string";
  for (const provider of providers) await atomicWrite(launcherPath(store.root, provider), launcherWrapper(process.execPath, script, provider, electron), 0o700);
}

function commandArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === "string") || !value[0]) throw new Error("The CLI command must be a nonempty array of arguments.");
  return [...value];
}
function owned(command: string[] | null, wrapper: string): boolean { return command?.length === 1 && command[0] === wrapper; }
function sameProviders(left: readonly Provider[], right: readonly Provider[]): boolean { return left.length === right.length && left.every(provider => right.includes(provider)); }
/** Resolves a provider command to an executable path, or null when no executable exists. */
async function resolveCommand(command: string[], wrappers: string[]): Promise<string[] | null> {
  if (command.some(part => wrappers.includes(part))) throw new Error("A recursive launcher command was detected. Restore the original CLI.");
  const candidates = isAbsolute(command[0]) || command[0].includes("/") ? [resolve(command[0])] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, command[0]));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if (wrappers.includes(candidate) || wrappers.includes(resolved)) throw new Error("recursion");
      return [candidate, ...command.slice(1)];
    } catch (error) { if ((error as Error).message === "recursion") throw new Error("A recursive launcher command was detected. Restore the original CLI."); }
  }
  return null;
}

export async function prepareRuntime(paseo: PaseoApi, store: AccountStore, deadlineMs?: number): Promise<void> {
  await waitForIntegrationMutation(store, deadlineMs);
  const epoch = currentEpoch(store);
  try { await discoverRuntime(paseo, store, epoch, deadlineMs); }
  catch (error) {
    if (error instanceof IntegrationBusyError) { if (currentEpoch(store) !== epoch) return; throw error; }
    await waitForIntegrationMutation(store, deadlineMs);
    if (currentEpoch(store) !== epoch) return;
    const disable = store.change(state => { if (currentEpoch(store) === epoch) disableIntegration(state, "Could not verify provider commands or authentication. Check the integration settings."); });
    void disable.catch(() => {});
    const remaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (remaining === undefined) await disable;
    else if (remaining > 0) await withTimeout(disable, remaining, "Timed out updating provider configuration.").catch(() => {});
    if (currentEpoch(store) !== epoch) return;
    throw error;
  }
}

function disableIntegration(state: Registry, error: string): void {
  state.integration = { ...state.integration, enabled: false, error };
  for (const binding of state.bindings) {
    const awaitingReceipt = binding.launchToken !== null && binding.currentAccountId === null;
    binding.launchToken = null;
    if (binding.status === "switching" || awaitingReceipt) {
      binding.currentAccountId = null; binding.status = "error"; binding.error = error;
    }
  }
}

/** Clears active managed bindings after Paseo's provider commands are restored to the system CLIs.
 * Preserves `launchAccountId` so a running agent on account A with a different `pendingAccountId` B still protects A from removal/sign-in. */
export function disableBindingsForRestore(state: Registry): void {
  for (const b of state.bindings) {
    b.launchToken = null;
    if (b.currentAccountId !== `system-${b.provider}`) {
      b.pendingAccountId = b.pendingAccountId ?? b.currentAccountId ?? b.launchAccountId;
      b.currentAccountId = null;
      b.status = "error";
      b.error = "Integration is disabled. The next reload will use the system CLI.";
    }
  }
}

function isTransientTimeout(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "DAEMON_REQUEST_TIMEOUT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\btimed out\b|\btimeout waiting for\b|no response to get_daemon_config_request/i.test(message);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, makeError?: () => Error): Promise<T> {
  void promise.catch(() => {});
  const timeoutError = () => makeError ? makeError() : Object.assign(new Error(message), { code: "DAEMON_REQUEST_TIMEOUT" });
  if (ms <= 0) return Promise.reject(timeoutError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms);
    timer.unref?.();
    promise.then(
      value => { if (timer) clearTimeout(timer); resolve(value); },
      error => { if (timer) clearTimeout(timer); reject(error); },
    );
  });
}

async function getDaemonConfig(paseo: PaseoApi, deadlineMs?: number): Promise<Awaited<ReturnType<PaseoApi["config"]["get"]>>> {
  const totalBudget = deadlineMs === undefined ? CONFIG_GET_TIMEOUT_MS * 2 : Math.min(CONFIG_GET_TIMEOUT_MS * 2, deadlineMs - Date.now());
  if (totalBudget <= 0) throw new IntegrationBusyError("Timed out reading Paseo daemon configuration.");
  const endAt = Date.now() + totalBudget;
  const startAttempt = () => Promise.resolve().then(() => paseo.config.get());
  const first = startAttempt();
  const firstWait = Math.min(CONFIG_GET_TIMEOUT_MS, totalBudget);
  try {
    return await withTimeout(first, firstWait, "Timed out reading Paseo daemon configuration.", () => new IntegrationBusyError("Timed out reading Paseo daemon configuration."));
  } catch (error) {
    if (!isTransientTimeout(error) && !(error instanceof IntegrationBusyError)) throw error;
    const remaining = endAt - Date.now();
    if (remaining <= 0) throw new IntegrationBusyError("Timed out reading Paseo daemon configuration.");
    // Keep the first in-flight request in the race alongside the retry so a slow valid response arriving slightly past 4s still succeeds,
    // and treat double transient timeouts as IntegrationBusyError so the current RPC fails closed without permanently disabling integration.
    const second = startAttempt();
    const raced = new Promise<Awaited<ReturnType<PaseoApi["config"]["get"]>>>((resolve, reject) => {
      let failures = 0;
      const fail = (err: unknown) => {
        if (!isTransientTimeout(err)) { reject(err); return; }
        failures++;
        if (failures === 2) reject(new IntegrationBusyError("Timed out reading Paseo daemon configuration."));
      };
      first.then(resolve, fail);
      second.then(resolve, fail);
    });
    return await withTimeout(raced, remaining, "Timed out reading Paseo daemon configuration.", () => new IntegrationBusyError("Timed out reading Paseo daemon configuration."));
  }
}

export async function reconcileIntegration(paseo: PaseoApi, store: AccountStore, deadlineMs?: number): Promise<void> {
  await waitForIntegrationMutation(store, deadlineMs);
  const epoch = currentEpoch(store);
  let registry: Registry;
  let ownership: Provider[];
  try {
    const { config } = await getDaemonConfig(paseo, deadlineMs);
    await waitForIntegrationMutation(store, deadlineMs);
    if (currentEpoch(store) !== epoch) return;
    registry = await store.read();
    if (currentEpoch(store) !== epoch) return;
    ownership = providers.filter(provider => owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider)));
    // Complete any persisted restore cleanup BEFORE checking auth overrides so an override on the restored system CLI
    // (e.g. OPENAI_API_KEY) cannot prevent clearing managed bindings once Paseo no longer points at our wrappers.
    if (registry.integration.restorePending && ownership.length === 0) {
      const finishRestore = store.change(state => {
        if (currentEpoch(store) !== epoch || !state.integration.restorePending) return;
        state.integration = { ...state.integration, enabled: false, error: null, restorePending: undefined };
        disableBindingsForRestore(state);
      });
      void finishRestore.catch(() => {});
      const restoreRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
      if (restoreRemaining === undefined) await finishRestore;
      else if (restoreRemaining > 0) await withTimeout(finishRestore, restoreRemaining, "Timed out updating provider configuration.", () => new IntegrationBusyError("Timed out updating provider configuration."));
      else throw new IntegrationBusyError("Timed out updating provider configuration.");
      registry = await store.read();
      if (currentEpoch(store) !== epoch) return;
    }
    for (const provider of providers) {
      // A provider without a CLI never launches, so its settings cannot affect the other.
      if (!registry.available[provider]) continue;
      assertSubscriptionEnvironment(provider, process.env);
      const environment = config.providers[provider]?.env;
      assertSubscriptionEnvironment(provider, environment && typeof environment === "object" ? environment as Record<string, unknown> : {});
    }
  } catch (error) {
    if (error instanceof IntegrationBusyError) { if (currentEpoch(store) !== epoch) return; throw error; }
    await waitForIntegrationMutation(store, deadlineMs);
    if (currentEpoch(store) !== epoch) return;
    const message = "Could not verify Paseo provider commands. Check the configuration and authentication overrides, then enable integration again.";
    const disable = store.change(state => { if (currentEpoch(store) === epoch) disableIntegration(state, message); });
    void disable.catch(() => {});
    const remaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (remaining === undefined) await disable;
    else if (remaining > 0) await withTimeout(disable, remaining, message).catch(() => {});
    if (currentEpoch(store) !== epoch) return;
    throw new Error(message);
  }
  // Restoring the wrapper paths alone cannot authorize old launch receipts.
  // Only explicit installIntegration enables a disabled registry again.
  if (ownership.length && sameProviders(ownership, registry.integration.providers)) return;
  await waitForIntegrationMutation(store, deadlineMs);
  if (currentEpoch(store) !== epoch) return;
  const driftWrite = store.change(state => {
    if (currentEpoch(store) !== epoch) return;
    if (ownership.length && sameProviders(ownership, state.integration.providers)) return;
    if (state.integration.enabled || ownership.length || state.bindings.some(binding => binding.launchToken !== null)) disableIntegration(state, COMMAND_DRIFT);
  });
  void driftWrite.catch(() => {});
  const driftRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
  if (driftRemaining === undefined) await driftWrite;
  else if (driftRemaining > 0) await withTimeout(driftWrite, driftRemaining, "Timed out updating provider configuration.", () => new IntegrationBusyError("Timed out updating provider configuration."));
  else throw new IntegrationBusyError("Timed out updating provider configuration.");
}

async function discoverCommands(paseo: PaseoApi, store: AccountStore, deadlineMs?: number) {
  try { return await discoverRuntime(paseo, store, undefined, deadlineMs); }
  catch (error) {
    if (error instanceof IntegrationBusyError) throw error;
    const disable = store.change(state => { disableIntegration(state, "Could not verify provider commands or authentication. Check the integration settings."); });
    void disable.catch(() => {});
    const remaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (remaining === undefined) await disable;
    else if (remaining > 0) await withTimeout(disable, remaining, "Timed out updating provider configuration.").catch(() => {});
    throw error;
  }
}

async function discoverRuntime(paseo: PaseoApi, store: AccountStore, guardedEpoch?: number, deadlineMs?: number) {
  const { config } = await getDaemonConfig(paseo, deadlineMs);
  if (guardedEpoch !== undefined && currentEpoch(store) !== guardedEpoch) return config;
  const registry = await store.read();
  if (guardedEpoch !== undefined && currentEpoch(store) !== guardedEpoch) return config;
  // The shared bundle counts as a launcher too: `node bin/launcher.js codex` saved as the original command would recurse.
  const wrappers = [...providers.map(provider => launcherPath(store.root, provider)), launcherScriptPath(store.root)];
  const commands = { ...registry.commands }, originals = { ...registry.originalCommands }, sourceHomes = { ...registry.sourceHomes };
  const sourceEnvironment: typeof registry.sourceEnvironment = { claude: {}, codex: {} };
  const available = { claude: false, codex: false };
  const ownership: Provider[] = [];
  for (const provider of providers) {
    if (owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider))) ownership.push(provider);
  }
  // If a prior restore switched Paseo back to system CLIs before its cleanup write finished (crash/restart, disk error,
  // or immediate re-enable), complete that cleanup BEFORE checking auth overrides or re-enabling integration.
  if (registry.integration.restorePending && ownership.length === 0) {
    const finishRestore = store.change(state => {
      if (guardedEpoch !== undefined && currentEpoch(store) !== guardedEpoch) return;
      if (!state.integration.restorePending) return;
      state.integration = { ...state.integration, enabled: false, error: null, restorePending: undefined };
      disableBindingsForRestore(state);
    });
    void finishRestore.catch(() => {});
    const restoreRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (restoreRemaining === undefined) await finishRestore;
    else if (restoreRemaining > 0) await withTimeout(finishRestore, restoreRemaining, "Timed out updating provider configuration.", () => new IntegrationBusyError("Timed out updating provider configuration."));
    else throw new IntegrationBusyError("Timed out updating provider configuration.");
    if (guardedEpoch !== undefined && currentEpoch(store) !== guardedEpoch) return config;
  }
  for (const provider of providers) {
    const current = commandArray(config.providers[provider]?.command);
    if (owned(current, launcherPath(store.root, provider))) {
      if (!commands[provider]) throw new Error("The launcher is active without the original CLI command; restore the configuration manually.");
      // Keep the recorded command when its CLI is gone: restoration still needs it.
      const resolved = await resolveCommand(commands[provider]!, wrappers);
      if (resolved) commands[provider] = resolved;
      available[provider] = resolved !== null;
    } else {
      originals[provider] = current;
      commands[provider] = await resolveCommand(current ?? [provider], wrappers);
      available[provider] = commands[provider] !== null;
    }
    if (!available[provider]) { Object.assign(sourceEnvironment[provider], registry.sourceEnvironment[provider]); continue; }
    const environment = config.providers[provider]?.env;
    const configured = environment && typeof environment === "object" ? environment as Record<string, unknown> : {};
    assertSubscriptionEnvironment(provider, process.env);
    assertSubscriptionEnvironment(provider, configured);
    const keys = provider === "claude" ? ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const : ["CODEX_HOME"] as const;
    for (const key of keys) {
      const value = configured[key] ?? process.env[key];
      // An explicitly empty override selects the default credential namespace.
      if(key==="CLAUDE_SECURESTORAGE_CONFIG_DIR"&&value===""){
        sourceEnvironment.claude.CLAUDE_SECURESTORAGE_CONFIG_DIR="";
        continue;
      }
      if (typeof value === "string" && value) {
        if (!isAbsolute(value)) throw new Error("The provider profile path must be absolute.");
        (sourceEnvironment[provider] as Record<string, string>)[key] = value;
      }
    }
    const value = provider === "claude" ? sourceEnvironment.claude.CLAUDE_CONFIG_DIR : sourceEnvironment.codex.CODEX_HOME;
    sourceHomes[provider] = typeof value === "string" && isAbsolute(value) ? resolve(value) : join(homedir(), provider === "claude" ? ".claude" : ".codex");
  }
  if (!available.claude && !available.codex) throw new Error(NO_PROVIDER_CLI);
  await writeLaunchers(store);
  // The wrapper must see its originals before the daemon can run provider discovery.
  if (guardedEpoch !== undefined) {
    await waitForIntegrationMutation(store, deadlineMs);
    if (currentEpoch(store) !== guardedEpoch) return config;
  }
  const changeRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
  if (changeRemaining !== undefined && changeRemaining <= 0) throw new IntegrationBusyError("Timed out updating provider configuration.");
  const update = store.change(state => {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new IntegrationBusyError("Timed out updating provider configuration.");
    if (guardedEpoch !== undefined && currentEpoch(store) !== guardedEpoch) return;
    state.commands = commands; state.originalCommands = originals; state.sourceHomes = sourceHomes; state.sourceEnvironment = sourceEnvironment; state.available = available;
    if (!sameProviders(ownership, state.integration.providers) && (ownership.length || state.integration.enabled || state.bindings.some(binding => binding.launchToken !== null))) disableIntegration(state, COMMAND_DRIFT);
    for (const account of state.accounts) if (account.source === "system") account.home = sourceHomes[account.provider];
  });
  await (changeRemaining === undefined ? update : withTimeout(update, changeRemaining, "Timed out updating provider configuration.", () => new IntegrationBusyError("Timed out updating provider configuration.")));
  return config;
}

export async function installIntegration(paseo: PaseoApi, store: AccountStore, deadlineMs?: number): Promise<void> {
  await waitForIntegrationMutation(store, deadlineMs);
  const config = await discoverCommands(paseo, store, deadlineMs), { available } = await store.read();
  // A provider without a CLI keeps its Paseo command. One whose launcher is already installed stays owned.
  const integrated = providers.filter(provider => available[provider] || owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider)));
  await trackIntegrationMutation(store, async holdUntil => {
    let patchTimedOut = false;
    try {
      const patchTimeout = deadlineMs === undefined ? CONFIG_PATCH_TIMEOUT_MS : Math.min(CONFIG_PATCH_TIMEOUT_MS, deadlineMs - Date.now());
      if (patchTimeout <= 0) throw new Error("Timed out applying provider integration.");
      const patchPromise = Promise.resolve().then(() => paseo.config.patch({ providers: Object.fromEntries(integrated.map(provider => [provider, { ...config.providers[provider], command: [launcherPath(store.root, provider)] }])) }));
      // If config.patch succeeds after our local timeout, record fail-closed drift before releasing the mutation gate
      // unless integration is already enabled for the exact same provider set (a redundant no-op enable).
      const patchGate = patchPromise.then(async () => {
        if (!patchTimedOut) return;
        await store.change(state => {
          if (state.integration.enabled && sameProviders(integrated, state.integration.providers)) return;
          disableIntegration(state, COMMAND_DRIFT);
        }).catch(() => {});
      }, () => {});
      holdUntil(patchGate);
      try {
        await withTimeout(patchPromise, patchTimeout, "Timed out applying provider integration.");
      } catch (error) {
        patchTimedOut = true;
        throw error;
      }
      const commitRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
      if (commitRemaining !== undefined && commitRemaining <= 0) {
        holdUntil(store.change(state => {
          if (state.integration.enabled && sameProviders(integrated, state.integration.providers)) return;
          disableIntegration(state, COMMAND_DRIFT);
        }).catch(() => {}));
        throw new Error("Timed out applying provider integration.");
      }
      // Attach bumpEpoch directly to commitPromise so a write finishing fsync/rename right after timeout
      // still advances the epoch before the mutation gate releases, while a failed write never bumps the epoch.
      const commitPromise = store.change(state => {
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          if (!state.integration.enabled || !sameProviders(integrated, state.integration.providers)) disableIntegration(state, COMMAND_DRIFT);
          return false;
        }
        state.integration = { enabled: true, error: null, providers: integrated, restorePending: undefined };
        return true;
      });
      const commitWithEpoch = commitPromise.then(committed => {
        if (committed) bumpEpoch(store);
        else throw new Error("Timed out applying provider integration.");
      });
      holdUntil(commitWithEpoch);
      await (commitRemaining === undefined ? commitWithEpoch : withTimeout(commitWithEpoch, commitRemaining, "Timed out applying provider integration."));
    } catch { throw new Error("Paseo did not apply provider integration. Check the configuration and try again."); }
  });
}

export async function restoreIntegration(paseo: PaseoApi, store: AccountStore, deadlineMs?: number): Promise<void> {
  await waitForIntegrationMutation(store, deadlineMs);
  await trackIntegrationMutation(store, async holdUntil => {
    let missingOriginalError: Error | undefined;
    let patchTimedOut = false;
    let patchDispatched = false;
    let markedByUs = false;
    const commitRestore = () => store.change(state => {
      state.integration = { ...state.integration, enabled: false, error: null, restorePending: undefined };
      disableBindingsForRestore(state);
    }).then(() => { bumpEpoch(store); });
    const clearPending = () => store.change(state => {
      if (state.integration.restorePending) state.integration = { ...state.integration, restorePending: undefined };
    }).catch(() => {});
    try {
      // Persist restorePending BEFORE reading fresh daemon config and patching commands back to system CLIs.
      // Keeping integration.enabled true until config.patch succeeds preserves direct retry in Accounts UI and
      // keeps active bindings intact if config.patch fails, while restorePending blocks managed env injection
      // and guarantees crash/restart/auth-override/re-enable recovery if the daemon applied the restore.
      const markRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
      if (markRemaining !== undefined && markRemaining <= 0) throw new Error("Timed out restoring provider commands.");
      const markPromise = store.change(state => {
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error("Timed out restoring provider commands.");
        const hadPending = !!state.integration.restorePending;
        // Mark ownership before atomicWrite so even a timeout mid-write rolls back our restorePending flag cleanly.
        if (!hadPending) markedByUs = true;
        state.integration = { ...state.integration, restorePending: true };
        return { originalCommands: { ...state.originalCommands }, commands: { ...state.commands } };
      });
      holdUntil(markPromise);
      const saved = await (markRemaining === undefined ? markPromise : withTimeout(markPromise, markRemaining, "Timed out restoring provider commands."));
      // Read daemon config AFTER the registry queue step so we never overwrite provider settings changed while waiting.
      const { config } = await getDaemonConfig(paseo, deadlineMs);
      const patch: Record<string, Record<string, unknown>> = {};
      for (const provider of providers) {
        if (!owned(commandArray(config.providers[provider]?.command), launcherPath(store.root, provider))) continue;
        const command = saved.originalCommands[provider] ?? saved.commands[provider];
        if (!command?.length) {
          missingOriginalError = new Error("The original CLI command is missing; automatic restoration is unavailable.");
          throw missingOriginalError;
        }
        patch[provider] = { ...config.providers[provider], command };
      }
      const patched = Object.keys(patch).length > 0;
      if (patched) {
        const patchTimeout = deadlineMs === undefined ? CONFIG_PATCH_TIMEOUT_MS : Math.min(CONFIG_PATCH_TIMEOUT_MS, deadlineMs - Date.now());
        if (patchTimeout <= 0) throw new Error("Timed out restoring provider commands.");
        patchDispatched = true;
        const patchPromise = Promise.resolve().then(() => paseo.config.patch({ providers: patch }));
        const patchGate = patchPromise.then(async () => {
          if (!patchTimedOut) return;
          await commitRestore().catch(() => {});
        }, async () => {
          try {
            const live = await getDaemonConfig(paseo, Date.now() + CONFIG_GET_TIMEOUT_MS);
            const stillOwned = providers.some(provider => owned(commandArray(live.config.providers[provider]?.command), launcherPath(store.root, provider)));
            if (!stillOwned) await commitRestore().catch(() => {});
            else if (markedByUs) await clearPending();
          } catch { /* Retain restorePending on disk so restart/reconcile/re-enable resolves it once daemon responds. */ }
        });
        holdUntil(patchGate);
        try {
          await withTimeout(patchPromise, patchTimeout, "Timed out restoring provider commands.");
        } catch (error) {
          patchTimedOut = true;
          throw error;
        }
      }
      const commitRemaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
      if (!patched && commitRemaining !== undefined && commitRemaining <= 0) throw new Error("Timed out restoring provider commands.");
      const commitWithEpoch = store.change(state => {
        if (!patched && deadlineMs !== undefined && Date.now() >= deadlineMs) {
          if (markedByUs && state.integration.restorePending) state.integration = { ...state.integration, restorePending: undefined };
          throw new Error("Timed out restoring provider commands.");
        }
        state.integration = { ...state.integration, enabled: false, error: null, restorePending: undefined };
        disableBindingsForRestore(state);
      }).then(() => { bumpEpoch(store); });
      holdUntil(commitWithEpoch);
      if (commitRemaining !== undefined && commitRemaining <= 0) throw new Error("Timed out restoring provider commands.");
      await (commitRemaining === undefined ? commitWithEpoch : withTimeout(commitWithEpoch, commitRemaining, "Timed out restoring provider commands."));
    } catch {
      if (markedByUs && !patchDispatched) holdUntil(clearPending());
      if (missingOriginalError) throw missingOriginalError;
      throw new Error("Paseo did not restore the original provider commands. Try again.");
    }
  });
}
