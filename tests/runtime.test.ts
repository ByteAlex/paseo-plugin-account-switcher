import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { AccountStore } from "../server/store";
import { accountCommand, accountEnvironment, launchLogin, probeAccount, removeAccountCredentials } from "../server/auth";
import { installIntegration, launcherPath, launcherScriptPath, launcherWrapper, prepareRuntime, reconcileIntegration, restoreIntegration, writeLaunchers } from "../server/integration";
import { profileEnv } from "../server/session-env";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "account runtime space ")); roots.push(root);
  const store = new AccountStore(root);
  await store.initialize({ claude: join(root, "source claude"), codex: join(root, "source codex") });
  const cli = join(root, "fake cli.cjs");
  await writeFile(cli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) {
 if(process.env.FAKE_FAIL) { console.error('private-secret'); process.exit(1); }
 if(args.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'person@example.test',orgId:'org',subscriptionType:'max'}));
 else console.error('Logged in using ChatGPT');
} else if(args.includes('--wait')) {
 process.on('SIGTERM',()=>{console.log('terminated');process.exit(23)}); console.log('ready'); setInterval(()=>{},1000);
} else {
 console.log(JSON.stringify({args,home:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,key:process.env.OPENAI_API_KEY,custom:process.env.CUSTOM,electron:process.env.ELECTRON_RUN_AS_NODE??null,marker:process.env.ACCOUNT_SWITCHER_ELECTRON??null}));
 process.stdin.pipe(process.stdout);
}
`);
  await store.change(registry => { registry.commands = { claude: [process.execPath, cli], codex: [process.execPath, cli] }; });
  return { root, store, cli };
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })); child.stdin.end(input);
  });
}

describe("standalone native-provider launcher", () => {
  it("runs on the plugin's Node even when the agent's PATH starts with an old one (#58)", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    // What a project's mise or nvm shim puts first: a Node 12 that cannot parse the node22 bundle.
    const shims = join(root, "pinned node 12"); await mkdir(shims);
    await writeFile(join(shims, "node"), "#!/bin/sh\necho \"SyntaxError: Unexpected token '.'\" >&2\nexit 1\n", { mode: 0o755 });
    const result = await run(launcherPath(root, "codex"), ["--version"], { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH ?? ""}` });
    expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ["--version"] });
  });

  it("refuses an original command that runs the shared bundle, which would start launchers without end", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    await store.change(registry => { registry.commands.codex = [process.execPath, launcherScriptPath(root), "codex"]; });
    const result = await run(launcherPath(root, "codex"), ["--version"], process.env);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Original provider command is unavailable");
  });

  it("quotes the paths it writes into the wrapper, and passes arguments through untouched", async () => {
    const script = launcherWrapper("/opt/it's node/bin/node", "/root/bin/launcher.js", "claude", false);
    expect(script).toBe("#!/bin/sh\n# Account Switcher claude launcher, written by the plugin at every start. Do not edit.\nexec '/opt/it'\\''s node/bin/node' '/root/bin/launcher.js' claude \"$@\"\n");
  });

  it("runs Electron as Node for the launcher only, never for the provider CLI", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    // The wrapper a desktop-managed daemon writes; plain Node ignores the variable, so the test can run it.
    await writeFile(launcherPath(root, "codex"), launcherWrapper(process.execPath, launcherScriptPath(root), "codex", true), { mode: 0o700 });
    const result = await run(launcherPath(root, "codex"), ["--version"], process.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ electron: null, marker: null });
  });

  it("selects the bound profile, shares history, preserves argv/stdin, and writes a correlated receipt", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Work");
    await mkdir(account.home, { recursive: true });
    await store.prepare("agent/one", "codex", account.id);
    await store.change(registry => { const binding = registry.bindings[0]; binding.launchAccountId = account.id; binding.launchToken = "launch-1"; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server", "argument with spaces", "$(touch nope)"], { ...process.env, PASEO_AGENT_ID: "agent/one", OPENAI_API_KEY: "secret", CUSTOM: "kept" }, "byte-transparent\n");
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const [first, ...rest] = result.stdout.split("\n");
    expect(JSON.parse(first)).toMatchObject({ home: account.home, custom: "kept", args: ["app-server", "argument with spaces", "$(touch nope)"] });
    expect(JSON.parse(first).key).toBeUndefined(); expect(rest.join("\n")).toBe("byte-transparent\n");
    const receipt = JSON.parse(await readFile(join(root, "receipts", "agent%2Fone.json"), "utf8"));
    expect(receipt).toMatchObject({ accountId: account.id, launchToken: "launch-1" }); expect(receipt.pid).toBeGreaterThan(0);
    expect(await readFile(join(account.home, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    expect((await stat(launcherPath(root, "codex"))).mode & 0o777).toBe(0o700);
  });

  it("preserves original environment and command arguments for unmanaged sessions", async () => {
    const { root, store } = await fixture();
    await store.change(registry => { registry.commands.codex!.push("prefix with spaces"); });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["--version"], { ...process.env, CODEX_HOME: "/user/original home", OPENAI_API_KEY: "original-key" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ["prefix with spaces", "--version"], home: "/user/original home", key: "original-key" });
  });

  it("fails explicitly when an assigned profile disappears", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Gone");
    await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("profile");
  });

  it("starts no CLI when its binding was released while the profile was prepared", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Work");
    await mkdir(account.home, { recursive: true });
    await store.prepare("slow", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; registry.bindings[0].launchToken = "launch-1"; });
    await writeLaunchers(store);
    // Reading the source's config.toml waits on this FIFO, which holds the launcher in prepareProfile until the test lets go.
    const source = (await store.read()).sourceHomes.codex; await mkdir(source, { recursive: true });
    const config = join(source, "config.toml");
    expect(spawnSync("mkfifo", [config]).status).toBe(0);
    const launch = run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "slow" });
    const reading = await open(config, "w");
    await store.change(registry => { registry.bindings = []; });
    await reading.close();
    const result = await launch;
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("released");
    await expect(stat(join(root, "receipts", "slow.json"))).rejects.toThrow();
  }, 20_000);

  it("refuses managed launches while restorePending is set or when integration disables mid-preparation", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Work");
    await mkdir(account.home, { recursive: true });
    await store.prepare("restoring", "codex", account.id);
    await store.change(registry => {
      registry.integration.enabled = true;
      registry.integration.restorePending = true;
      registry.bindings[0].launchAccountId = account.id;
      registry.bindings[0].launchToken = "launch-r";
    });
    await writeLaunchers(store);
    const duringPending = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "restoring", CODEX_HOME: account.home });
    expect(duringPending.code).not.toBe(0); expect(duringPending.stdout).toBe(""); expect(duringPending.stderr).toContain("disabled");
    // Now test a launcher paused in prepareProfile while a full restore completes (clearing restorePending and setting enabled=false, binding.status="error").
    await store.change(registry => { registry.integration.restorePending = undefined; });
    const source = (await store.read()).sourceHomes.codex; await mkdir(source, { recursive: true });
    const config = join(source, "config.toml");
    expect(spawnSync("mkfifo", [config]).status).toBe(0);
    const launch = run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "restoring" });
    const reading = await open(config, "w");
    await store.change(registry => {
      registry.integration.enabled = false;
      registry.bindings[0].currentAccountId = null;
      registry.bindings[0].launchToken = null;
      registry.bindings[0].status = "error";
    });
    await reading.close();
    const afterRestore = await launch;
    expect(afterRestore.code).not.toBe(0); expect(afterRestore.stdout).toBe(""); expect(afterRestore.stderr).toContain("released");
  }, 20_000);

  it("refuses a profile redirected to the shared home by a symlink", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Redirected");
    const source = (await store.read()).sourceHomes.codex;
    await mkdir(join(root, "accounts", account.id), { recursive: true }); await mkdir(source, { recursive: true });
    await symlink(source, account.home);
    await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("profile");
  });

  it("does not reveal corrupt registry content or run an original command", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    await writeFile(join(root, "registry.json"), "{ private-secret-invalid-json");
    const result = await run(launcherPath(root, "codex"), ["app-server"], process.env);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("registry"); expect(result.stderr).not.toContain("private-secret");
  });

  it("rejects prefix arguments that override the selected subscription account", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Protected");
    await mkdir(account.home, { recursive: true }); await store.prepare("assigned", "codex", account.id);
    await store.change(registry => { registry.bindings[0].launchAccountId = account.id; registry.commands.codex!.push("-c", 'model_provider="proxy"'); });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["app-server"], { ...process.env, PASEO_AGENT_ID: "assigned" });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("isolation");
  });

  it("forwards SIGTERM to the official process and preserves its exit code", async () => {
    const { root, store } = await fixture(); await writeLaunchers(store);
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(launcherPath(root, "codex"), ["--wait"], { env: process.env, stdio: "pipe" }); let output = "";
      child.on("error", reject); child.stdout.on("data", data => { output += data; if (String(data).includes("ready")) child.kill("SIGTERM"); });
      child.on("close", code => resolve({ code, output }));
    });
    expect(result).toEqual({ code: 23, output: "ready\nterminated\n" });
  });

  it("runs official isolated login and records completion only after its exit", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Login");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "login-1"; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "codex"), ["--account-switcher-login", account.id], { ...process.env, OPENAI_API_KEY: "secret" });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ args: ["login", "--device-auth"], home: account.home });
    expect(JSON.parse(result.stdout).key).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "login-1", exitCode: 0 });
  });

  it("records a sanitized failed-login receipt if the official binary cannot start", async () => {
    const { root, store } = await fixture(); const account = await store.add("claude", "Login");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "login-failed"; registry.commands.claude = [join(root, "missing-secret-path")]; });
    await writeLaunchers(store);
    const result = await run(launcherPath(root, "claude"), ["--account-switcher-login", account.id], process.env);
    expect(result.code).toBe(1); expect(result.stderr).not.toContain("missing-secret-path");
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "login-failed", exitCode: 1 });
  });
});

describe("auth and config integration", () => {
  it("deletes only the managed Claude Keychain namespace and never the system service", async () => {
    const { store } = await fixture(); const account = await store.add("claude", "Delete me");
    const remove = vi.fn(async () => {}), registry = await store.read();
    await removeAccountCredentials(account, registry, { platform: "darwin", remove });
    const suffix = createHash("sha256").update(account.home.normalize("NFC")).digest("hex").slice(0, 8);
    expect(remove).toHaveBeenCalledExactlyOnceWith(["delete-generic-password", "-a", process.env.USER && /^[a-zA-Z0-9._-]+$/.test(process.env.USER) ? process.env.USER : "claude-code-user", "-s", `Claude Code-credentials-${suffix}`]);
    await expect(removeAccountCredentials(registry.accounts[0], registry, { platform: "darwin", remove })).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("keeps the default system Claude Keychain namespace and pins explicit source environments", async () => {
    const { store } = await fixture(), registry = await store.read();
    const claude = registry.accounts.find(account => account.provider === "claude")!;
    expect(accountEnvironment(claude, registry, { CLAUDE_CONFIG_DIR: "/wrong", ANTHROPIC_API_KEY: "system-key" })).toEqual({ ANTHROPIC_API_KEY: "system-key" });
    registry.sourceEnvironment.claude = { CLAUDE_CONFIG_DIR: claude.home, CLAUDE_SECURESTORAGE_CONFIG_DIR: claude.home };
    expect(accountEnvironment(claude, registry, {})).toEqual(registry.sourceEnvironment.claude);
    const codex = registry.accounts.find(account => account.provider === "codex")!;
    expect(accountEnvironment(codex, registry, { CODEX_HOME: "/wrong", OPENAI_API_KEY: "system-key" })).toEqual({ CODEX_HOME: codex.home, OPENAI_API_KEY: "system-key" });
  });

  it("probes Claude through the official CLI and exposes metadata only", async () => {
    const { store } = await fixture(); const account = await store.add("claude", "Claude"); await mkdir(account.home, { recursive: true });
    expect(await probeAccount(account, await store.read())).toMatchObject({ email: "person@example.test", plan: "max", authStatus: "ready" });
    const env = accountEnvironment(account, await store.read(), { ANTHROPIC_API_KEY: "secret", CUSTOM: "yes" });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: account.home, CUSTOM: "yes" });
  });

  it("decodes Codex identity without returning token material", async () => {
    const { store } = await fixture(); const account = await store.add("codex", "Codex"); await mkdir(account.home, { recursive: true });
    const payload = Buffer.from(JSON.stringify({ email: "codex@example.test", sub: "user-1", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } })).toString("base64url");
    await writeFile(join(account.home, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${payload}.signature`, access_token: "must-never-return", account_id: "acct-1" } }));
    const result = await probeAccount(account, await store.read());
    expect(result).toMatchObject({ identityKey: "acct-1", email: "codex@example.test", plan: "plus", authStatus: "ready" });
    expect(JSON.stringify(result)).not.toContain("must-never-return"); expect(JSON.stringify(result)).not.toContain(payload);
  });

  it("installs once, preserves provider settings and original args, and restores only owned commands", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli, "original arg"], enabled: true, custom: "keep" }, codex: { command: [process.execPath, cli], enabled: true }, other: { command: ["other"] } } };
    const patch = vi.fn(async (change) => { config = { ...config, providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); await installIntegration(paseo, store);
    expect(config.providers.claude).toMatchObject({ command: [launcherPath(root, "claude")], custom: "keep" });
    expect((await store.read()).originalCommands.claude).toEqual([process.execPath, cli, "original arg"]);
    config.providers.codex.command = ["user-replacement"];
    await restoreIntegration(paseo, store);
    expect(config.providers.claude.command).toEqual([process.execPath, cli, "original arg"]);
    expect(config.providers.codex.command).toEqual(["user-replacement"]); expect(config.providers.other.command).toEqual(["other"]);
  });

  it("opens login in a safe Paseo workspace with argv arrays", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Account");
    await mkdir(account.home, { recursive: true });
    const create = vi.fn(async () => ({ id: "terminal-id" })), setTitle = vi.fn();
    const open = vi.fn(async () => ({ id: "workspace-id", setTitle }));
    const paseo = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }), open }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id)).toEqual({ terminalId: "terminal-id", workspaceId: "workspace-id" });
    expect(open).toHaveBeenCalledWith({ cwd: join(root, "login", account.id) }); expect(setTitle).toHaveBeenCalledWith("Sign in · Codex · Account");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ command: launcherPath(root, "codex"), args: ["--account-switcher-login", account.id], cwd: join(root, "login", account.id) }));
  });

  it("opens the chosen Codex browser login directly through a Paseo terminal", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Browser account");
    await mkdir(account.home, { recursive: true });
    await store.change(registry => { registry.accounts.find(row => row.id === account.id)!.loginToken = "browser-login"; });
    const create = vi.fn(async (_options: Parameters<PaseoApi["terminals"]["create"]>[0]) => ({ id: "browser-terminal" })), setTitle = vi.fn();
    const paseo = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }), open: vi.fn(async () => ({ id: "browser-workspace", setTitle })) }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id, undefined, "browser")).toEqual({ terminalId: "browser-terminal", workspaceId: "browser-workspace" });
    expect(setTitle).toHaveBeenCalledWith("Sign in · Codex · Browser account");
    const options = create.mock.calls[0][0];
    expect(options).toMatchObject({ command: launcherPath(root, "codex"), args: ["--account-switcher-login", account.id, "--browser"] });
    const result = await run(options.command!, options.args!, process.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ args: ["login"], home: account.home });
    expect(JSON.parse(await readFile(join(root, "logins", `${account.id}.json`), "utf8"))).toMatchObject({ loginToken: "browser-login", exitCode: 0 });
  });

  it("keeps supplied workspace ownership while isolating Claude's login working directory", async () => {
    const { root, store } = await fixture(); const account = await store.add("claude", "Claude account");
    await mkdir(account.home, { recursive: true });
    const create = vi.fn(async () => ({ id: "claude-terminal" })), open = vi.fn();
    const paseo = { workspaces: { open }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id, "existing-workspace", "browser")).toEqual({ terminalId: "claude-terminal", workspaceId: "existing-workspace" });
    expect(open).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "existing-workspace", command: launcherPath(root, "claude"), args: ["--account-switcher-login", account.id], cwd: join(root, "login", account.id) }));
  });

  it("reconciles external command drift without patching the user's replacement and preserves it on later restore", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    config.providers.codex.command = [process.execPath, cli, "user-change"];
    await prepareRuntime(paseo, store);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false); expect(registry.integration.error).toMatch(/commands/i);
    expect(registry.originalCommands.codex).toEqual([process.execPath, cli, "user-change"]);
    expect(config.providers.claude.command).toEqual([launcherPath(root, "claude")]); expect(patch).not.toHaveBeenCalled();
    await installIntegration(paseo, store);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    await restoreIntegration(paseo, store);
    expect(config.providers.codex.command).toEqual([process.execPath, cli, "user-change"]);
  });

  it("treats an externally replaced command that cannot be resolved as a missing CLI and disables integration", async () => {
    const { store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    config.providers.codex.command = ["/nonexistent/account-switcher-fixture-cli"];
    await prepareRuntime(paseo, store);
    const registry = await store.read();
    expect(registry.integration).toMatchObject({ enabled: false, error: expect.stringMatching(/commands/i) });
    expect(registry.available).toEqual({ claude: true, codex: false });
    expect(registry.commands.codex).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it("revokes pending launch receipts on live drift and requires explicit enable after wrapper ownership returns", async () => {
    const { root, store, cli } = await fixture();
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    await store.change(state => {
      state.bindings.push({ agentId: "in-flight", provider: "codex", currentAccountId: "system-codex", pendingAccountId: "system-codex", launchAccountId: "system-codex", launchToken: "old-switch-receipt", status: "switching", error: null, registrationObserved: true });
      state.bindings.push({ agentId: "default-start", provider: "claude", currentAccountId: null, pendingAccountId: null, launchAccountId: "system-claude", launchToken: "old-default-receipt", status: "ready", error: null, registrationObserved: false });
      state.bindings.push({ agentId: "confirmed", provider: "claude", currentAccountId: "system-claude", pendingAccountId: null, launchAccountId: "system-claude", launchToken: null, status: "ready", error: null, registrationObserved: true });
    });
    const launcherBefore = await stat(launcherPath(root, "claude"));
    config.providers.codex.command = ["/not-resolvable-and-must-not-be-resolved"];
    await reconcileIntegration(paseo, store);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false);
    expect(registry.bindings.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "in-flight", currentAccountId: null, launchToken: null, status: "error" }),
      expect.objectContaining({ agentId: "default-start", currentAccountId: null, launchToken: null, status: "error" }),
    ]));
    expect(registry.bindings[2]).toMatchObject({ currentAccountId: "system-claude", status: "ready" });
    expect((await stat(launcherPath(root, "claude"))).ino).toBe(launcherBefore.ino);
    expect(patch).not.toHaveBeenCalled();
    config.providers.codex.command = [launcherPath(root, "codex")];
    await reconcileIntegration(paseo, store);
    await prepareRuntime(paseo, store);
    expect((await store.read()).integration.enabled).toBe(false);
    await installIntegration(paseo, store);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    expect((await store.read()).bindings.every(binding => binding.launchToken === null)).toBe(true);
  });

  it("integrates only the installed CLI and adds the other once it is installed and integration is enabled again", async () => {
    const { root, store, cli } = await fixture();
    vi.stubEnv("PATH", join(root, "no provider cli"));
    let config: { providers: Record<string, { command?: string[] }> } = { providers: { claude: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await prepareRuntime(paseo, store);
    expect((await store.read()).available).toEqual({ claude: true, codex: false });
    await installIntegration(paseo, store);
    expect(Object.keys(patch.mock.calls[0][0].providers)).toEqual(["claude"]);
    expect(config.providers.codex).toBeUndefined();
    await reconcileIntegration(paseo, store);
    let snapshot = await store.snapshot();
    expect(snapshot.integration).toEqual({ enabled: true, error: null });
    expect(snapshot.providers).toEqual({ claude: { available: true, integrated: true }, codex: { available: false, integrated: false } });

    config.providers.codex = { command: [process.execPath, cli] };
    await prepareRuntime(paseo, store); await reconcileIntegration(paseo, store);
    snapshot = await store.snapshot();
    expect(snapshot.integration.enabled).toBe(true);
    expect(snapshot.providers.codex).toEqual({ available: true, integrated: false });
    await installIntegration(paseo, store);
    expect(config.providers.codex.command).toEqual([launcherPath(root, "codex")]);
    expect((await store.snapshot()).providers.codex).toEqual({ available: true, integrated: true });
  });

  it("names the missing CLI instead of failing every account operation", async () => {
    const { root, store, cli } = await fixture();
    vi.stubEnv("PATH", join(root, "no provider cli"));
    const paseo = { config: { get: async () => ({ config: { providers: { codex: { command: [process.execPath, cli] } } } }), patch: vi.fn() } } as unknown as PaseoApi;
    await prepareRuntime(paseo, store);
    const registry = await store.read();
    expect(registry.available).toEqual({ claude: false, codex: true });
    expect(() => accountCommand(registry, "claude")).toThrow("Claude Code CLI was not found on the daemon");
    expect(accountCommand(registry, "codex")).toEqual([process.execPath, cli]);
  });

  it("ignores authentication overrides that only concern a provider without a CLI", async () => {
    const { root, store, cli } = await fixture();
    vi.stubEnv("PATH", join(root, "no provider cli")); vi.stubEnv("OPENAI_API_KEY", "fixture-ambient-private");
    let config: { providers: Record<string, { command?: string[] }> } = { providers: { claude: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); await reconcileIntegration(paseo, store);
    const registry = await store.read();
    expect(registry.integration).toEqual({ enabled: true, error: null, providers: ["claude"] });
    expect(JSON.stringify(registry)).not.toContain("fixture-ambient-private");
  });

  it("keeps integration and the recorded command when an integrated CLI is removed", async () => {
    const { root, store, cli } = await fixture();
    const codex = join(root, "removable codex"); await writeFile(codex, "#!/bin/sh\n", { mode: 0o755 });
    let config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [codex] } } };
    const patch = vi.fn(async change => { config = { providers: { ...config.providers, ...change.providers } }; return { config }; });
    const paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store); patch.mockClear();
    await rm(codex);
    await prepareRuntime(paseo, store); await reconcileIntegration(paseo, store);
    const registry = await store.read();
    expect(registry.integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    expect(registry.available).toEqual({ claude: true, codex: false });
    expect(registry.commands.codex).toEqual([codex]);
    expect((await store.snapshot()).providers.codex).toEqual({ available: false, integrated: true });
    expect(patch).not.toHaveBeenCalled();
    await restoreIntegration(paseo, store);
    expect(config.providers.codex.command).toEqual([codex]);
  });

  it("fails with a clear error when neither provider CLI can be found", async () => {
    const { root, store } = await fixture();
    vi.stubEnv("PATH", join(root, "no provider cli"));
    await store.change(state => { state.integration.enabled = true; });
    const patch = vi.fn(), paseo = { config: { get: async () => ({ config: { providers: {} } }), patch } } as unknown as PaseoApi;
    await expect(prepareRuntime(paseo, store)).rejects.toThrow("Provider CLI not found. Install Claude Code or Codex");
    expect((await store.read()).integration.enabled).toBe(false);
    await expect(installIntegration(paseo, store)).rejects.toThrow("Provider CLI not found");
    expect(patch).not.toHaveBeenCalled();
  });

  it("fails closed on unavailable live config without retrying non-timeout errors or exposing raw errors", async () => {
    const { store } = await fixture(); await store.change(state => { state.integration.enabled = true; });
    const get = vi.fn(async () => { throw new Error("fixture-private-config-value"); });
    const paseo = { config: { get } } as unknown as PaseoApi;
    await expect(reconcileIntegration(paseo, store)).rejects.toThrow("Could not verify Paseo provider commands");
    expect(get).toHaveBeenCalledTimes(1);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false); expect(JSON.stringify(registry)).not.toContain("fixture-private-config-value");
  });

  it("retries once on transient config timeouts without permanently disabling integration on double timeouts", async () => {
    const { root, store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { Object.assign(config.providers, change.providers); return { config }; });
    const get = vi.fn(async () => ({ config }));
    const paseo = { config: { get, patch } } as unknown as PaseoApi;
    get.mockRejectedValueOnce(Object.assign(new Error("Timeout waiting for message (60000ms)"), { code: "DAEMON_REQUEST_TIMEOUT" }));
    await prepareRuntime(paseo, store);
    expect(get).toHaveBeenCalledTimes(2);
    await installIntegration(paseo, store);
    get.mockClear();
    get.mockRejectedValueOnce(new Error("Timeout waiting for message (60000ms)"));
    await reconcileIntegration(paseo, store);
    expect(get).toHaveBeenCalledTimes(2);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    expect(config.providers.claude.command).toEqual([launcherPath(root, "claude")]);
    get.mockClear();
    get.mockRejectedValue(new Error("No response to get_daemon_config_request after 1500ms"));
    await expect(reconcileIntegration(paseo, store)).rejects.toThrow(/timed out reading paseo daemon configuration/i);
    expect(get).toHaveBeenCalledTimes(2);
    // Double transient timeouts fail the current RPC closed without permanently disabling integration.
    expect((await store.read()).integration.enabled).toBe(true);
  });

  it("keeps the first slow config.get in the hedged retry race so a >4s response still succeeds", async () => {
    const { store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { Object.assign(config.providers, change.providers); return { config }; });
    const setupPaseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await installIntegration(setupPaseo, store);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let resolveFirst!: (value: { config: typeof config }) => void;
      const get = vi.fn()
        .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise(() => {}));
      const pending = reconcileIntegration({ config: { get } } as unknown as PaseoApi, store);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(get).toHaveBeenCalledTimes(2);
      // First request responds at 4.5s while second is still pending: hedged race succeeds!
      await vi.advanceTimersByTimeAsync(500);
      resolveFirst({ config });
      await pending;
      expect((await store.read()).integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not undo a concurrent installIntegration from stale reconcileIntegration or prepareRuntime, while failed installs still fail closed", async () => {
    const { root, store, cli } = await fixture();
    vi.stubEnv("PATH", join(root, "no provider cli"));
    const config: { providers: Record<string, { command?: string[] }> } = { providers: { claude: { command: [process.execPath, cli] } } };
    const patch = vi.fn(async change => { Object.assign(config.providers, change.providers); return { config }; });
    const paseo = { config: { get: async () => ({ config: structuredClone(config) }), patch } } as unknown as PaseoApi;
    await installIntegration(paseo, store);
    config.providers.codex = { command: [process.execPath, cli] };
    await prepareRuntime(paseo, store);
    // Capture the pre-install config snapshot (codex still unowned) and deliver it AFTER installIntegration commits.
    const staleSnapshot = structuredClone(config);
    let releaseStale!: () => void, staleStarted!: () => void;
    const enteredStale = new Promise<void>(resolve => { staleStarted = resolve; });
    const stalePaseo = {
      config: {
        get: vi.fn(async () => {
          staleStarted();
          await new Promise<void>(resolve => { releaseStale = resolve; });
          return { config: staleSnapshot };
        }),
      },
    } as unknown as PaseoApi;
    const staleReconcile = reconcileIntegration(stalePaseo, store);
    await enteredStale;
    // Also start a stale prepareRuntime (startup discovery) before installIntegration commits.
    let releaseDiscovery!: () => void, discoveryStarted!: () => void;
    const enteredDiscovery = new Promise<void>(resolve => { discoveryStarted = resolve; });
    const discoveryPaseo = {
      config: {
        get: vi.fn(async () => {
          discoveryStarted();
          await new Promise<void>(resolve => { releaseDiscovery = resolve; });
          return { config: staleSnapshot };
        }),
      },
    } as unknown as PaseoApi;
    const staleDiscovery = prepareRuntime(discoveryPaseo, store);
    await enteredDiscovery;
    // Also start a second reconciliation whose attempts both fail while installIntegration runs.
    let failSecond!: (error: Error) => void, failStarted!: () => void;
    const enteredFail = new Promise<void>(resolve => { failStarted = resolve; });
    const failingPaseo = {
      config: {
        get: vi.fn()
          .mockRejectedValueOnce(new Error("Timeout waiting for message (60000ms)"))
          .mockImplementationOnce(() => { failStarted(); return new Promise((_, reject) => { failSecond = reject; }); }),
      },
    } as unknown as PaseoApi;
    const failingReconcile = reconcileIntegration(failingPaseo, store);
    await enteredFail;
    await installIntegration(paseo, store);
    releaseStale();
    releaseDiscovery();
    failSecond(new Error("Timeout waiting for message (60000ms)"));
    await Promise.all([staleReconcile, staleDiscovery, failingReconcile]);
    expect((await store.read()).integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    // A reconciliation starting mid-patch (after daemon config shows the new launcher, before registry commits) must not clear launch tokens.
    await store.change(state => {
      state.integration = { enabled: true, error: null, providers: ["claude"] };
      state.bindings.push({ agentId: "mid-install", provider: "claude", currentAccountId: null, pendingAccountId: null, launchAccountId: "system-claude", launchToken: "keep-me", status: "ready", error: null, registrationObserved: false });
    });
    config.providers.codex = { command: [process.execPath, cli] };
    await prepareRuntime(paseo, store);
    let finishPatch!: () => void, patchEntered!: () => void;
    const enteredPatch = new Promise<void>(resolve => { patchEntered = resolve; });
    const slowPatch = vi.fn(async change => {
      Object.assign(config.providers, change.providers);
      patchEntered();
      await new Promise<void>(resolve => { finishPatch = resolve; });
      return { config };
    });
    const slowInstall = installIntegration({ config: { get: async () => ({ config: structuredClone(config) }), patch: slowPatch } } as unknown as PaseoApi, store);
    await enteredPatch;
    const midInstallReconcile = reconcileIntegration({ config: { get: async () => ({ config: structuredClone(config) }) } } as unknown as PaseoApi, store);
    await Promise.resolve();
    finishPatch();
    await Promise.all([slowInstall, midInstallReconcile]);
    const afterMidInstall = await store.read();
    expect(afterMidInstall.integration).toEqual({ enabled: true, error: null, providers: ["claude", "codex"] });
    expect(afterMidInstall.bindings.find(b => b.agentId === "mid-install")?.launchToken).toBe("keep-me");
    // A concurrent failed install must NOT suppress fail-closed drift detection in reconcileIntegration.
    let failPatch!: (error: Error) => void, failPatchEntered!: () => void;
    const enteredFailPatch = new Promise<void>(resolve => { failPatchEntered = resolve; });
    const failingInstall = installIntegration({
      config: {
        get: async () => ({ config: structuredClone(config) }),
        patch: () => { failPatchEntered(); return new Promise((_, reject) => { failPatch = reject; }); },
      },
    } as unknown as PaseoApi, store);
    await enteredFailPatch;
    const drifted = structuredClone(config);
    drifted.providers.codex.command = [process.execPath, cli];
    const concurrentDrift = reconcileIntegration({ config: { get: async () => ({ config: drifted }) } } as unknown as PaseoApi, store);
    failPatch(new Error("patch refused"));
    await expect(failingInstall).rejects.toThrow(/did not apply/);
    await concurrentDrift;
    expect((await store.read()).integration.enabled).toBe(false);
  });

  it("bounds waiting on a slow integration patch without disabling integration or clearing launch tokens", async () => {
    const { store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const paseo = { config: { get: async () => ({ config: structuredClone(config) }), patch: vi.fn(async change => { Object.assign(config.providers, change.providers); return { config }; }) } } as unknown as PaseoApi;
    await installIntegration(paseo, store);
    await store.change(r => {
      r.bindings.push({ agentId: "busy-patch", provider: "codex", currentAccountId: null, pendingAccountId: null, launchAccountId: "system-codex", launchToken: "keep-busy", status: "ready", error: null, registrationObserved: false });
    });
    let releasePatch!: () => void, enteredPatch!: () => void;
    const patchStarted = new Promise<void>(resolve => { enteredPatch = resolve; });
    const hungInstall = installIntegration({
      config: {
        get: async () => ({ config: structuredClone(config) }),
        patch: () => { enteredPatch(); return new Promise(resolve => { releasePatch = () => resolve({ config }); }); },
      },
    } as unknown as PaseoApi, store);
    await patchStarted;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const waiting = reconcileIntegration({ config: { get: async () => ({ config: structuredClone(config) }) } } as unknown as PaseoApi, store);
      const outcome = waiting.then(() => "ok", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await outcome).toMatch(/integration change is still in progress/i);
      const state = await store.read();
      expect(state.integration.enabled).toBe(true);
      expect(state.bindings.find(b => b.agentId === "busy-patch")?.launchToken).toBe("keep-busy");
    } finally {
      vi.useRealTimers();
      releasePatch();
      await hungInstall;
    }
  });

  it("keeps fail-closed verification when installIntegration fails to write the registry, and bounds slow config.patch under deadline", async () => {
    const { store, cli } = await fixture();
    const config: { providers: Record<string, { command: string[] }> } = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: ["/missing/codex"] } } };
    const initialPaseo = { config: { get: async () => ({ config: structuredClone(config) }), patch: vi.fn(async (change: { providers: Record<string, { command: string[] }> }) => { Object.assign(config.providers, change.providers); return { config }; }) } } as unknown as PaseoApi;
    await installIntegration(initialPaseo, store);
    // Now Codex CLI becomes available; installIntegration patches both providers, then fails its registry write.
    config.providers.codex = { command: [process.execPath, cli] };
    let releasePatch!: () => void, enteredPatch!: () => void;
    const patchStarted = new Promise<void>(resolve => { enteredPatch = resolve; });
    const patchedConfig = structuredClone(config);
    const partialInstall = installIntegration({
      config: {
        get: async () => ({ config: structuredClone(config) }),
        patch: async (change: { providers: Record<string, { command: string[] }> }) => {
          Object.assign(patchedConfig.providers, change.providers);
          enteredPatch();
          await new Promise<void>(resolve => { releasePatch = resolve; });
          return { config: patchedConfig };
        },
      },
    } as unknown as PaseoApi, store);
    await patchStarted;
    // Fail only the post-patch registry commit write inside installIntegration; subsequent writes still work.
    const changeSpy = vi.spyOn(store, "change").mockRejectedValueOnce(new Error("disk full"));
    // Start a concurrent verification while patch is running: once install's registry write fails,
    // epoch must remain unchanged so verification fails closed against the mismatched daemon state.
    const verify = reconcileIntegration({ config: { get: async () => ({ config: structuredClone(patchedConfig) }) } } as unknown as PaseoApi, store);
    releasePatch();
    await expect(partialInstall).rejects.toThrow(/did not apply/);
    changeSpy.mockRestore();
    await verify;
    expect((await store.read()).integration.enabled).toBe(false);
    expect((await store.read()).integration.error).toMatch(/Provider commands changed/i);
    // Also verify installIntegration:
    // (a) never dispatches config.patch when deadline is already expired,
    // (b) rejects promptly when config.patch stalls past deadline, holding the mutation gate until patch settles,
    //     and never commits registry.json late even if patch resolves afterward.
    const expiredPatch = vi.fn();
    await expect(installIntegration({
      config: { get: async () => ({ config: structuredClone(config) }), patch: expiredPatch },
    } as unknown as PaseoApi, store, Date.now() - 1)).rejects.toThrow(/timed out/i);
    expect(expiredPatch).not.toHaveBeenCalled();

    let enteredSlowPatch!: () => void, resolveLatePatch!: () => void;
    const slowPatchStarted = new Promise<void>(resolve => { enteredSlowPatch = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const deadline = Date.now() + 2_000;
      const lateConfig = structuredClone(config);
      const slowPatchInstall = installIntegration({
        config: {
          get: async () => ({ config: structuredClone(lateConfig) }),
          patch: (change: { providers: Record<string, { command: string[] }> }) => {
            enteredSlowPatch();
            return new Promise(resolve => {
              resolveLatePatch = () => {
                Object.assign(lateConfig.providers, change.providers);
                resolve({ config: lateConfig });
              };
            });
          },
        },
      } as unknown as PaseoApi, store, deadline);
      const outcome = slowPatchInstall.then(() => "ok", (error: Error) => error.message);
      await slowPatchStarted;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toMatch(/did not apply/i);
      // While the timed-out patch is still pending, the mutation gate remains held so concurrent calls fail fast as busy.
      const busyCheck = reconcileIntegration({ config: { get: async () => ({ config: structuredClone(lateConfig) }) } } as unknown as PaseoApi, store, Date.now() + 1_000).then(() => "ok", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await busyCheck).toMatch(/integration change is still in progress/i);
      // When the late patch finally applies to the daemon config, fail-closed drift is recorded before releasing the gate.
      resolveLatePatch();
      vi.useRealTimers();
      await vi.waitFor(async () => expect((await store.read()).integration.error).toMatch(/Provider commands changed/i));
      expect((await store.read()).integration.enabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // Also verify a late restoreIntegration patch synchronizes registry.json and runs binding cleanup before releasing the gate,
    // while preserving launchAccountId so a running agent on account A with pending selection B still protects A.
    const restoreConfig = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const restoreSetup = { config: { get: async () => ({ config: structuredClone(restoreConfig) }), patch: vi.fn(async (change: { providers: Record<string, { command: string[] }> }) => { Object.assign(restoreConfig.providers, change.providers); return { config: restoreConfig }; }) } } as unknown as PaseoApi;
    await installIntegration(restoreSetup, store);
    await store.change(r => {
      r.bindings.push({ agentId: "late-restore-agent", provider: "codex", currentAccountId: "managed-A", pendingAccountId: "managed-B", launchAccountId: "managed-A", launchToken: "tok-lr", status: "ready", error: null, registrationObserved: true });
    });
    let enteredSlowRestore!: () => void, resolveLateRestore!: () => void;
    const slowRestoreStarted = new Promise<void>(resolve => { enteredSlowRestore = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const restoreDeadline = Date.now() + 2_000;
      const slowRestore = restoreIntegration({
        config: {
          get: async () => ({ config: structuredClone(restoreConfig) }),
          patch: (change: { providers: Record<string, { command: string[] }> }) => {
            enteredSlowRestore();
            return new Promise(resolve => {
              resolveLateRestore = () => {
                Object.assign(restoreConfig.providers, change.providers);
                resolve({ config: restoreConfig });
              };
            });
          },
        },
      } as unknown as PaseoApi, store, restoreDeadline);
      const restoreOutcome = slowRestore.then(() => "ok", (error: Error) => error.message);
      await slowRestoreStarted;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await restoreOutcome).toMatch(/did not restore/i);
      resolveLateRestore();
      vi.useRealTimers();
      await vi.waitFor(async () => expect((await store.read()).integration.enabled).toBe(false));
      const cleaned = (await store.read()).bindings.find(b => b.agentId === "late-restore-agent");
      expect(cleaned).toMatchObject({ currentAccountId: null, pendingAccountId: "managed-B", launchAccountId: "managed-A", launchToken: null, status: "error" });
    } finally {
      vi.useRealTimers();
    }
    // Verify: (a) a late no-op enable on already-healthy integration does NOT disable it or clear launch tokens,
    // (b) a failed restore patch that did NOT change daemon commands keeps enabled: true for direct retry in Accounts UI,
    // and (c) persisted restorePending completes binding cleanup across restarts even when an auth override is present.
    const healthyConfig = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli] } } };
    const healthySetup = { config: { get: async () => ({ config: structuredClone(healthyConfig) }), patch: vi.fn(async (change: { providers: Record<string, { command: string[] }> }) => { Object.assign(healthyConfig.providers, change.providers); return { config: healthyConfig }; }) } } as unknown as PaseoApi;
    await installIntegration(healthySetup, store);
    await store.change(r => {
      r.bindings.push({ agentId: "keep-healthy", provider: "codex", currentAccountId: "managed-2", pendingAccountId: "managed-3", launchAccountId: "managed-2", launchToken: "tok-kh", status: "ready", error: null, registrationObserved: true });
    });
    let enteredNoop!: () => void, resolveNoop!: () => void;
    const noopStarted = new Promise<void>(resolve => { enteredNoop = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const noopInstall = installIntegration({
        config: {
          get: async () => ({ config: structuredClone(healthyConfig) }),
          patch: () => { enteredNoop(); return new Promise(resolve => { resolveNoop = () => resolve({ config: healthyConfig }); }); },
        },
      } as unknown as PaseoApi, store, Date.now() + 1_000);
      const noopOutcome = noopInstall.then(() => "ok", (error: Error) => error.message);
      await noopStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await noopOutcome).toMatch(/did not apply/i);
      resolveNoop();
      vi.useRealTimers();
      await Promise.resolve();
      await Promise.resolve();
      expect((await store.read()).integration.enabled).toBe(true);
      expect((await store.read()).bindings.find(b => b.agentId === "keep-healthy")?.launchToken).toBe("tok-kh");
    } finally {
      vi.useRealTimers();
    }
    // Failed restore patch that leaves launchers in daemon config keeps integration.enabled true so user can directly retry Disable.
    const unchangedConfig = structuredClone(healthyConfig);
    await expect(restoreIntegration({
      config: {
        get: async () => ({ config: structuredClone(unchangedConfig) }),
        patch: async () => { throw new Error("daemon refused patch"); },
      },
    } as unknown as PaseoApi, store)).rejects.toThrow(/did not restore/i);
    await vi.waitFor(async () => expect((await store.read()).integration.restorePending).toBeUndefined());
    expect((await store.read()).integration.enabled).toBe(true);
    // Persisted restorePending:
    // (1) blocks profileEnv from injecting managed credentials during the restore window,
    // (2) is NOT erased by a failed/expired retry of restoreIntegration, and
    // (3) survives a fresh AccountStore (simulated restart) and completes cleanup even if an auth override is set.
    const managedForEnv = await store.add("codex", "Env Managed");
    await store.change(r => {
      r.integration.restorePending = true;
      r.bindings.push({ agentId: "env-guarded", provider: "codex", currentAccountId: managedForEnv.id, pendingAccountId: null, launchAccountId: managedForEnv.id, launchToken: null, status: "ready", error: null, registrationObserved: true });
    });
    expect(profileEnv(await store.read(), "env-guarded", "codex")).toEqual({});
    await expect(restoreIntegration({
      config: { get: async () => { throw new Error("config unavailable"); }, patch: vi.fn() },
    } as unknown as PaseoApi, store, Date.now() - 1)).rejects.toThrow(/did not restore/i);
    expect((await store.read()).integration.restorePending).toBe(true);
    const restartedStore = new AccountStore(store.root);
    const restoredWithOverride = { providers: { claude: { command: [process.execPath, cli] }, codex: { command: [process.execPath, cli], env: { OPENAI_API_KEY: "override" } } } };
    await expect(reconcileIntegration({ config: { get: async () => ({ config: restoredWithOverride }) } } as unknown as PaseoApi, restartedStore)).rejects.toThrow(/Could not verify Paseo provider commands/);
    const afterRestart = await restartedStore.read();
    expect(afterRestart.integration.enabled).toBe(false);
    expect(afterRestart.integration.restorePending).toBeUndefined();
    expect(afterRestart.bindings.find(b => b.agentId === "keep-healthy")).toMatchObject({ currentAccountId: null, pendingAccountId: "managed-3", launchAccountId: "managed-2", launchToken: null, status: "error" });
  });

  it.each([
    ["claude", "ANTHROPIC_API_KEY"], ["claude", "CLAUDE_CODE_OAUTH_TOKEN"], ["claude", "ANTHROPIC_BASE_URL"],
    ["codex", "OPENAI_API_KEY"], ["codex", "CODEX_API_KEY"], ["codex", "OPENAI_BASE_URL"],
  ])("rejects %s provider auth override %s without copying its value or patching config", async (provider, key) => {
    const { store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli], env: {} }, codex: { command: [process.execPath, cli], env: {} } } };
    (config.providers as Record<string, { env: Record<string, string> }>)[provider].env[key] = "fixture-private-value";
    const patch = vi.fn(), paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    await store.change(registry => { registry.integration.enabled = true; });
    await expect(reconcileIntegration(paseo, store)).rejects.toThrow("Could not verify Paseo provider commands");
    await expect(prepareRuntime(paseo, store)).rejects.toThrow(/authentication/);
    const registry = await store.read();
    expect(registry.integration.enabled).toBe(false);
    expect(JSON.stringify(registry)).not.toContain("fixture-private-value"); expect(patch).not.toHaveBeenCalled();
  });

  it("rejects ambient source auth overrides but accepts ordinary provider environment and supported profile paths", async () => {
    const { root, store, cli } = await fixture();
    const config = { providers: { claude: { command: [process.execPath, cli], env: { CUSTOM: "ordinary", CLAUDE_CONFIG_DIR: join(root, "claude-home") } }, codex: { command: [process.execPath, cli], env: { CUSTOM: "ordinary", CODEX_HOME: join(root, "codex-home") } } } };
    const patch = vi.fn(), paseo = { config: { get: async () => ({ config }), patch } } as unknown as PaseoApi;
    vi.stubEnv("OPENAI_API_KEY", "fixture-ambient-private");
    await expect(prepareRuntime(paseo, store)).rejects.toThrow(/authentication/);
    expect(JSON.stringify(await store.read())).not.toContain("fixture-ambient-private");
    vi.unstubAllEnvs();
    await prepareRuntime(paseo, store);
    expect((await store.read()).sourceHomes).toEqual({ claude: join(root, "claude-home"), codex: join(root, "codex-home") });
    expect(patch).not.toHaveBeenCalled();
  });

  it("reuses the exact login workspace across attempts and pages while leaving unrelated and archiving workspaces alone", async () => {
    const { root, store } = await fixture(); const account = await store.add("codex", "Account"); await mkdir(account.home, { recursive: true });
    const cwd = join(root, "login", account.id);
    const list = vi.fn(async (options: { page: { cursor?: string } }) => options.page.cursor ? {
      entries: [{ id: "reusable", workspaceDirectory: cwd, archivingAt: null }], pageInfo: { hasMore: false, nextCursor: null },
    } : {
      entries: [{ id: "unrelated", workspaceDirectory: join(root, "project"), name: "Sign in · Codex · Account" }, { id: "archiving", workspaceDirectory: cwd, archivingAt: "2026-01-01T00:00:00Z" }],
      pageInfo: { hasMore: true, nextCursor: "next-page" },
    });
    const open = vi.fn(), archive = vi.fn(), create = vi.fn(async () => ({ id: "terminal-id" }));
    const paseo = { workspaces: { list, open, archive }, terminals: { create } } as unknown as PaseoApi;
    expect(await launchLogin(paseo, store, account.id)).toEqual({ terminalId: "terminal-id", workspaceId: "reusable" });
    expect(await launchLogin(paseo, store, account.id, undefined, "browser")).toEqual({ terminalId: "terminal-id", workspaceId: "reusable" });
    expect(list).toHaveBeenCalledTimes(4); expect(open).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "reusable", cwd, args: ["--account-switcher-login", account.id, "--browser"] }));
  });
});
