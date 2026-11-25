import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";

const mocks = vi.hoisted(() => ({
  launchLogin: vi.fn(), probeAccount: vi.fn(), removeAccountCredentials: vi.fn(),
  prepareRuntime: vi.fn(), reconcileIntegration: vi.fn(), execFile: vi.fn(), renewExpiredClaudeToken: vi.fn(),
  failRemovePath: undefined as string | undefined,
  usage: {
    checksEnabled: vi.fn(async () => true),
    start: vi.fn(), close: vi.fn(), invalidate: vi.fn(), refresh: vi.fn(), list: vi.fn(),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: PathLike, options: Parameters<typeof actual.rm>[1]) => {
      if (String(path) === mocks.failRemovePath) throw Object.assign(new Error("Profile cleanup denied"), { code: "EACCES" });
      return actual.rm(path, options);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: mocks.execFile,
}));

vi.mock("../server/auth", () => ({
  launchLogin: mocks.launchLogin, probeAccount: mocks.probeAccount, removeAccountCredentials: mocks.removeAccountCredentials,
  accountCommand: () => ["fixture-cli"], accountEnvironment: () => ({}),
}));
vi.mock("../server/integration", () => ({
  writeLaunchers: async () => {}, prepareRuntime: mocks.prepareRuntime, reconcileIntegration: mocks.reconcileIntegration,
  installIntegration: async () => {},
  restoreIntegration: async (_paseo: unknown, store: AccountStore) => {
    await store.change(r => {
      r.integration = { ...r.integration, enabled: false, error: null, restorePending: undefined };
      for (const b of r.bindings) {
        b.launchToken = null;
        if (b.currentAccountId !== `system-${b.provider}`) {
          b.pendingAccountId = b.pendingAccountId ?? b.currentAccountId ?? b.launchAccountId;
          b.currentAccountId = null; b.status = "error";
          b.error = "Integration is disabled. The next reload will use the system CLI.";
        }
      }
    });
  },
}));
vi.mock("../server/profiles", () => ({ prepareProfile: async () => {}, assertManagedCommand: async () => {} }));
vi.mock("../server/usage", () => ({ createUsageService: () => mocks.usage, readCredentialVersion: async () => "fixture-version" }));
vi.mock("../server/usage/claude", () => ({ renewExpiredClaudeToken: mocks.renewExpiredClaudeToken }));

import { AccountController } from "../server/controller";
import { AccountStore, accountFrom } from "../server/store";
import { SwitchRefusal } from "../server/switching";
import contribute from "../index.server";

const roots: string[] = [];
const controllers: AccountController[] = [];
const paseo = {
  agents: { ref: () => ({ refresh: async () => ({ agent: { provider: "codex", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null } }) }) },
} as unknown as PaseoApi;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.failRemovePath = undefined;
  mocks.launchLogin.mockReset().mockResolvedValue({ workspaceId: "login-workspace", terminalId: "login-terminal" });
  mocks.probeAccount.mockReset().mockResolvedValue({ identityKey: "fixture-account", email: "account@example.test", plan: "plus", authStatus: "ready" });
  mocks.removeAccountCredentials.mockReset().mockResolvedValue(undefined);
  mocks.prepareRuntime.mockReset().mockResolvedValue(undefined);
  mocks.reconcileIntegration.mockReset().mockResolvedValue(undefined);
  mocks.renewExpiredClaudeToken.mockReset().mockResolvedValue(false);
  mocks.execFile.mockReset().mockImplementation((...args: unknown[]) => { (args.at(-1) as (error: null, stdout: string) => void)(null, ""); });
  mocks.usage.close.mockResolvedValue(undefined);
  mocks.usage.refresh.mockResolvedValue([]);
  mocks.usage.list.mockResolvedValue([]);
});

afterEach(async () => {
  mocks.failRemovePath = undefined;
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), "account-controller-test-"));
  roots.push(root);
  return root;
}

async function start(root?: string) {
  const controller = new AccountController(root ?? await newRoot());
  controllers.push(controller);
  await controller.ready;
  return controller;
}

async function fixture() {
  const controller = await start();
  const account = await controller.store.add("codex", "Managed");
  await mkdir(account.home, { recursive: true });
  return { controller, account };
}

async function loginReceipt(root: string, id: string, loginToken: string, exitCode = 0) {
  await mkdir(join(root, "logins"), { recursive: true });
  await writeFile(join(root, "logins", `${id}.json`), JSON.stringify({ loginToken, exitCode }));
}

describe("persistent login isolation", () => {
  it("admits one login when two clients request the same account concurrently", async () => {
    const { controller, account } = await fixture();
    const attempts = await Promise.allSettled([controller.login(paseo, account.id), controller.login(paseo, account.id)]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
    expect(mocks.launchLogin).toHaveBeenCalledOnce();
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toEqual(expect.any(String));
  });

  it("keeps an unfinished login reserved after restart and blocks probes, deletion, apply and default launches", async () => {
    const { controller, account } = await fixture();
    await controller.login(paseo, account.id);
    const token = accountFrom(await controller.store.read(), account.id).loginToken;
    await controller.close();
    const restarted = await start(controller.store.root);
    expect(accountFrom(await restarted.store.read(), account.id).loginToken).toBe(token);
    await expect(restarted.login(paseo, account.id)).rejects.toThrow(/Sign-in is already open/);
    await expect(restarted.checkAccount(account.id)).rejects.toThrow(/Finish signing in/);
    await expect(restarted.remove(account.id)).rejects.toThrow(/Finish signing in/);
    await restarted.store.change(registry => { registry.integration.enabled = true; registry.defaults.codex = account.id; });
    const switcher = restarted.switcher(paseo);
    await switcher.prepare("agent-one", account.id);
    await expect(switcher.apply("agent-one")).rejects.toThrow(/Finish signing in/);
    await expect(switcher.bindNewAgent("agent-two", "codex")).rejects.toThrow(/Default account sign-in/);
    expect((await restarted.store.read()).bindings.some(binding => binding.agentId === "agent-two")).toBe(false);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
    expect(mocks.launchLogin).toHaveBeenCalledOnce();
  });

  it("keeps the lock for a missing or stale completion receipt, then unlocks only the matching login", async () => {
    const { controller, account } = await fixture();
    await controller.login(paseo, account.id);
    const token = accountFrom(await controller.store.read(), account.id).loginToken!;
    await expect(controller.finishLogin(account.id)).rejects.toThrow(/has not finished yet/);
    await loginReceipt(controller.store.root, account.id, "an-earlier-login");
    await expect(controller.finishLogin(account.id)).rejects.toThrow(/has not finished yet/);
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBe(token);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    await loginReceipt(controller.store.root, account.id, token);
    const completed = await controller.finishLogin(account.id);
    expect(completed).toMatchObject({ id: account.id, authStatus: "ready", email: "account@example.test" });
    expect(completed).not.toHaveProperty("loginToken");
    expect(completed).not.toHaveProperty("identityKey");
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    expect(mocks.probeAccount).toHaveBeenCalledOnce();
  });

  it("quarantines accounts with an open login from quota collection", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(registry => { registry.commands = { claude: ["fixture-cli"], codex: ["fixture-cli"] }; });
    await controller.login(paseo, account.id);
    const listed = await controller.quotaAccounts();
    expect(listed.map(item => item.id)).toEqual(["system-claude", "system-codex"]);
    expect(mocks.probeAccount.mock.calls.map(([item]) => item.id)).not.toContain(account.id);
  });

  it("releases a reservation when opening the login terminal fails, so retry works", async () => {
    const { controller, account } = await fixture();
    mocks.launchLogin.mockRejectedValueOnce(new Error("Terminal unavailable"));
    await expect(controller.login(paseo, account.id)).rejects.toThrow("Terminal unavailable");
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    await expect(controller.login(paseo, account.id)).resolves.toMatchObject({ terminalId: "login-terminal" });
  });
});

describe("expired Claude tokens", () => {
  it("lets the CLI renew before identity verification for limits, at most once per interval", async () => {
    const { controller } = await fixture();
    await controller.store.change(registry => { registry.commands = { claude: ["fixture-cli"], codex: ["fixture-cli"] }; });
    mocks.renewExpiredClaudeToken.mockResolvedValue(true);
    await controller.quotaAccounts({ verifyAccountId: "system-claude" });
    await controller.quotaAccounts({ verifyAccountId: "system-claude" });
    await controller.quotaAccounts({ verifyAccountId: "system-codex" });
    expect(mocks.renewExpiredClaudeToken).toHaveBeenCalledOnce();
    expect(mocks.renewExpiredClaudeToken.mock.calls[0][0]).toMatchObject({ id: "system-claude", command: ["fixture-cli"] });
    const probe = mocks.probeAccount.mock.calls.findIndex(([item]) => item.id === "system-claude");
    expect(mocks.renewExpiredClaudeToken.mock.invocationCallOrder[0]).toBeLessThan(mocks.probeAccount.mock.invocationCallOrder[probe]);
  });

  it("checks again on the next verification when the token was still valid", async () => {
    const { controller } = await fixture();
    await controller.store.change(registry => { registry.commands = { claude: ["fixture-cli"], codex: ["fixture-cli"] }; });
    await controller.quotaAccounts({ verifyAccountId: "system-claude" });
    await controller.quotaAccounts({ verifyAccountId: "system-claude" });
    expect(mocks.renewExpiredClaudeToken).toHaveBeenCalledTimes(2);
  });
});

describe("provider without a CLI", () => {
  it("refuses new accounts and leaves its accounts out of limits monitoring", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.commands = { claude: ["fixture-cli"], codex: ["fixture-cli"] }; r.available.codex = false; });
    await expect(controller.add("codex", "Another")).rejects.toThrow("Codex CLI was not found");
    expect((await controller.store.read()).accounts.filter(row => row.provider === "codex").map(row => row.id)).toEqual(["system-codex", account.id]);
    expect((await controller.quotaAccounts()).map(row => row.id)).toEqual(["system-claude"]);
    await expect(controller.checkAccount(account.id)).rejects.toThrow("Codex CLI was not found");
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    expect(accountFrom(await controller.store.read(), account.id).authStatus).toBe("needs_auth");
  });
});

describe("account deletion retry", () => {
  it("retains the registry and profile when credential cleanup fails", async () => {
    const { controller, account } = await fixture();
    mocks.removeAccountCredentials.mockRejectedValueOnce(new Error("Keychain unavailable"));
    await expect(controller.remove(account.id)).rejects.toThrow("Keychain unavailable");
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    await expect(access(account.home)).resolves.toBeUndefined();
    expect(mocks.usage.invalidate).not.toHaveBeenCalled();
    await controller.remove(account.id);
    expect((await controller.store.read()).accounts.some(item => item.id === account.id)).toBe(false);
    await expect(access(account.home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a retryable registry record when profile removal fails after credential cleanup", async () => {
    const { controller, account } = await fixture();
    mocks.failRemovePath = dirname(account.home);
    await expect(controller.remove(account.id)).rejects.toThrow("Profile cleanup denied");
    expect(mocks.removeAccountCredentials).toHaveBeenCalledOnce();
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    expect(mocks.usage.invalidate).not.toHaveBeenCalled();
    mocks.failRemovePath = undefined;
    await controller.remove(account.id);
    expect((await controller.store.snapshot()).accounts.some(item => item.id === account.id)).toBe(false);
    expect(mocks.usage.invalidate).toHaveBeenCalledWith(account.id);
  });
});

describe("unconfirmed session recovery", () => {
  it("protects a pending target from re-login when rollback left the actual account unknown", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("rollback-agent", "codex", account.id);
    await controller.store.change(registry => {
      const binding = registry.bindings[0];
      binding.currentAccountId = null;
      binding.launchAccountId = "system-codex";
      binding.status = "error";
    });
    await expect(controller.login(paseo, account.id)).rejects.toThrow(/Switch agents away/);
    expect(mocks.launchLogin).not.toHaveBeenCalled();
    expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
  });

  it("marks an interrupted switch unknown on startup and preserves its target reservation", async () => {
    const root = await newRoot();
    const store = new AccountStore(root);
    await store.initialize({ claude: join(root, "source-claude"), codex: join(root, "source-codex") });
    const target = await store.add("codex", "Target");
    await store.prepare("interrupted-agent", "codex", target.id);
    await store.change(registry => {
      const binding = registry.bindings[0];
      binding.status = "switching";
      binding.launchAccountId = target.id;
      binding.launchToken = "interrupted-launch";
    });
    const controller = await start(root);
    const binding = (await controller.store.snapshot()).bindings[0];
    expect(binding).toMatchObject({ currentAccountId: null, pendingAccountId: target.id, status: "error" });
    expect(binding.error).toContain("not confirmed");
    const stored = (await controller.store.read()).bindings[0];
    expect(stored.launchAccountId).toBe(target.id);
    await expect(controller.login(paseo, target.id)).rejects.toThrow(/Switch agents away/);
    await expect(controller.remove(target.id)).rejects.toThrow(/used by an agent/);
  });

  it("confirms a new default session only with the matching launch receipt and a live native session", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(registry => { registry.integration.enabled = true; registry.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("default-agent", "codex");
    const binding = (await controller.store.read()).bindings[0];
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    const receiptPath = join(controller.store.root, "receipts", "default-agent.json");
    await writeFile(receiptPath, JSON.stringify({ accountId: account.id, launchToken: "stale-launch" }));
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    await writeFile(receiptPath, JSON.stringify({ accountId: account.id, launchToken: binding.launchToken }));
    const unavailable = { agents: { ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi;
    expect((await controller.snapshot(unavailable)).bindings[0].currentAccountId).toBeNull();
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBe(account.id);
  });
});

function completeAgentPage(ids: string[], nextCursor: string | null = null) {
  return { entries: ids.map(id => ({ agent: { id, archivedAt: id.startsWith("archived") ? "2026-09-16T00:00:00Z" : null } })), pageInfo: { hasMore: nextCursor !== null, nextCursor, prevCursor: null } };
}

// Paseo answers null for an agent that is gone.
const goneAgents = { ref: () => ({ refresh: async () => null }) };

describe("deleted agent reconciliation", () => {
  it("protects the default before registration, then releases it after observed registration and deletion", async () => {
    const { controller, account } = await fixture();
    await controller.setDefault("codex", account.id);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.switcher(paseo).bindNewAgent("creating-agent", "codex");
    const host = { agents: { ...paseo.agents, ...goneAgents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "creating-agent", registrationObserved: false, launchAccountId: account.id });
    await expect(controller.remove(account.id, host)).rejects.toThrow(/used/);
    await controller.observeAgentRegistration("creating-agent");
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings).toEqual([]);
  });

  describe("an agent that never appeared", () => {
    const nobody = { agents: { ...paseo.agents, ...goneAgents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
    afterEach(() => { vi.useRealTimers(); });
    // Past the wait for a creation that Paseo never reports as failed.
    const tenMinutesLater = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 10 * 60_000 + 1); };
    async function failedStart(requested: string | null = null) {
      const { controller, account } = await fixture();
      await controller.store.change(r => { r.integration.enabled = true; });
      if (!requested) await controller.setDefault("codex", account.id);
      await controller.switcher(paseo).bindNewAgent("failed-agent", "codex", null, requested);
      await controller.setDefault("codex", null);
      return { controller, account };
    }

    it("holds its account while the creation may still be under way", async () => {
      const { controller, account } = await failedStart();
      await expect(controller.remove(account.id, nobody)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["failed-agent"]);
    });

    it("releases its account for removal once the creation cannot still be under way", async () => {
      const { controller, account } = await failedStart();
      tenMinutesLater();
      await controller.remove(account.id, nobody);
      const state = await controller.store.read();
      expect(state.bindings).toEqual([]);
      expect(state.accounts.some(a => a.id === account.id)).toBe(false);
    });

    it("releases an account named at the creation the same way", async () => {
      const { controller, account } = await failedStart("Managed");
      expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "failed-agent", launchAccountId: account.id });
      tenMinutesLater();
      await controller.remove(account.id, nobody);
      expect((await controller.store.read()).bindings).toEqual([]);
    });

    it("releases its account for signing in again", async () => {
      const { controller, account } = await failedStart();
      await expect(controller.login(nobody, account.id)).rejects.toThrow(/Switch agents away/);
      tenMinutesLater();
      await expect(controller.login(nobody, account.id)).resolves.toMatchObject({ terminalId: "login-terminal" });
    });

    it("gives a binding from an earlier release, which has no time, the same wait", async () => {
      const { controller, account } = await failedStart();
      await controller.store.change(r => { delete r.bindings[0].boundAt; });
      tenMinutesLater();
      await expect(controller.remove(account.id, nobody)).rejects.toThrow(/used by an agent/);
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await controller.remove(account.id, nobody);
      expect((await controller.store.read()).bindings).toEqual([]);
    });

    it("keeps the binding of an agent that appeared after all", async () => {
      const { controller, account } = await failedStart();
      tenMinutesLater();
      const appeared = { agents: { ...paseo.agents, list: async () => completeAgentPage(["failed-agent"]) } } as unknown as PaseoApi;
      await expect(controller.remove(account.id, appeared)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "failed-agent", registrationObserved: true });
    });

    // What the launcher writes as the CLI starts.
    async function launched(controller: AccountController, content: string) {
      await mkdir(join(controller.store.root, "receipts"), { recursive: true });
      await writeFile(join(controller.store.root, "receipts", "failed-agent.json"), content);
    }
    const receiptOf = (pid: number) => JSON.stringify({ accountId: "any", launchToken: "any", pid, at: "2026-10-31T00:00:00Z" });

    it("holds its account past the wait while the CLI of that launch still runs", async () => {
      const { controller, account } = await failedStart();
      await launched(controller, receiptOf(process.pid));
      tenMinutesLater();
      await expect(controller.remove(account.id, nobody)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["failed-agent"]);
    });

    it("releases its account once that CLI has exited", async () => {
      const { controller, account } = await failedStart();
      await launched(controller, receiptOf(spawnSync(process.execPath, ["-e", ""]).pid));
      tenMinutesLater();
      await controller.remove(account.id, nobody);
      expect((await controller.store.read()).bindings).toEqual([]);
    });

    it("releases its account when the receipt's PID went to a later process", async () => {
      const { controller, account } = await failedStart();
      await launched(controller, receiptOf(process.pid));
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        (args.at(-1) as (error: null, result: { stdout: string }) => void)(null, { stdout: "Sat Oct 31 20:04:51 2026\n" });
      });
      tenMinutesLater();
      await controller.remove(account.id, nobody);
      expect((await controller.store.read()).bindings).toEqual([]);
    });

    it.each([["cannot be read", "{"], ["names no process", JSON.stringify({ accountId: "any", launchToken: "any" })]])("holds its account when the launch receipt %s", async (_, content) => {
      const { controller, account } = await failedStart();
      await launched(controller, content);
      tenMinutesLater();
      await expect(controller.remove(account.id, nobody)).rejects.toThrow(/used by an agent/);
    });

    it("keeps the binding of an agent that the list leaves out and Paseo still knows", async () => {
      const { controller, account } = await failedStart();
      tenMinutesLater();
      const background = { agents: { ...paseo.agents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
      await expect(controller.remove(account.id, background)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "failed-agent", registrationObserved: true });
    });

    it("keeps the binding when the agent cannot be looked up", async () => {
      const { controller, account } = await failedStart();
      tenMinutesLater();
      const unknown = { agents: { ...paseo.agents, list: async () => completeAgentPage([]), ref: () => ({ refresh: async () => { throw new Error("offline"); } }) } } as unknown as PaseoApi;
      await expect(controller.remove(account.id, unknown)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "failed-agent", registrationObserved: false });
    });

    it("keeps the binding when the agent lookup interface is unavailable", async () => {
      const { controller, account } = await failedStart();
      tenMinutesLater();
      const offline = { agents: {} } as unknown as PaseoApi;
      await expect(controller.remove(account.id, offline)).rejects.toThrow(/used by an agent/);
      expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["failed-agent"]);
    });

    it("records positive registration during the creation grace period when a poll observes the agent", async () => {
      const { controller } = await failedStart();
      const alive = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "failed-agent", status: "idle" } }) }) } } as unknown as PaseoApi;
      await controller.snapshot(alive);
      expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "failed-agent", registrationObserved: true });
    });
  });

  it("keeps the binding of a registered agent that the list leaves out", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("background-agent", "codex", account.id);
    await controller.store.change(r => { r.bindings[0].currentAccountId = account.id; r.bindings[0].registrationObserved = true; });
    const background = { agents: { ...paseo.agents, list: async () => completeAgentPage([]) } } as unknown as PaseoApi;
    await controller.snapshot(background);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["background-agent"]);
  });

  it("releases deleted-agent bindings for login while retaining archived agents and skipping unrelated accounts", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("deleted-agent", "codex", account.id);
    await controller.store.change(r => { r.bindings[0].currentAccountId = account.id; r.bindings[0].launchAccountId = account.id; });
    await controller.store.prepare("unrelated-agent", "codex", "system-codex");
    const list = vi.fn();
    const ref = vi.fn((id: string) => ({
      refresh: async () => id === "unrelated-agent" ? { agent: { id, archivedAt: "2026-09-16T00:00:00Z" } } : null,
    }));
    const host = { agents: { ...paseo.agents, list, ref } } as unknown as PaseoApi;
    await expect(controller.login(host, account.id)).resolves.toMatchObject({ terminalId: "login-terminal" });
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["unrelated-agent"]);
    expect(list).not.toHaveBeenCalled();
    expect(ref).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledWith("deleted-agent");
  });

  it("lets the removal RPC path clear a deleted binding but protects an archived binding", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("deleted-agent", "codex", account.id);
    const host = { agents: { ...paseo.agents, ...goneAgents } } as unknown as PaseoApi;
    await controller.remove(account.id, host);
    expect((await controller.store.read()).accounts.some(a => a.id === account.id)).toBe(false);
    const archivedAccount = await controller.store.add("codex", "Archived owner");
    await controller.store.prepare("archived-agent", "codex", archivedAccount.id);
    const archivedHost = {
      agents: {
        ref: (id: string) => ({ refresh: async () => ({ agent: { id, archivedAt: "2026-09-16T00:00:00Z" } }) }),
      },
    } as unknown as PaseoApi;
    await expect(controller.remove(archivedAccount.id, archivedHost)).rejects.toThrow(/used by an agent/);
  });

  it("retains bindings whose lookup fails while still clearing confirmed-deleted siblings", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("protected-agent", "codex", account.id);
    await controller.store.prepare("deleted-agent", "codex", "system-codex");
    const host = {
      agents: {
        ...paseo.agents,
        ref: (id: string) => ({
          refresh: async () => {
            if (id === "protected-agent") throw new Error("offline");
            return null;
          },
        }),
      },
    } as unknown as PaseoApi;
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["protected-agent"]);
  });

  it("preserves bindings created while reconciliation is in flight and deduplicates concurrent snapshot polls", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("deleted-agent", "codex", account.id);
    let finish!: (value: null) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const refresh = vi.fn(() => { started(); return new Promise<null>(resolve => { finish = resolve; }); });
    const host = { agents: { ...paseo.agents, ref: () => ({ refresh }) } } as unknown as PaseoApi;
    const first = controller.snapshot(host);
    await entered;
    const second = controller.snapshot(host);
    await controller.store.prepare("new-agent", "codex", account.id);
    finish(null);
    await Promise.all([first, second]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["new-agent"]);
  });

  it("does not lose an observeAgentRegistration invalidation that arrives during an in-flight reconciliation", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.setDefault("codex", account.id);
    await controller.switcher(paseo).bindNewAgent("creating-agent", "codex");
    await controller.store.prepare("other-agent", "codex", "system-codex");
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let firstPass = true;
    const ref = vi.fn((id: string) => ({
      refresh: async () => {
        if (firstPass && id === "creating-agent") {
          started();
          await new Promise<void>(resolve => { finish = resolve; });
          return null;
        }
        return id === "other-agent" ? { agent: { id, status: "idle" } } : null;
      },
    }));
    const host = { agents: { ref } } as unknown as PaseoApi;
    const pending = controller.snapshot(host);
    await entered;
    await controller.observeAgentRegistration("creating-agent");
    finish();
    await pending;
    firstPass = false;
    // The invalidation was not clobbered by the finishing first pass, so the next snapshot immediately reconciles.
    await controller.snapshot(host);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["other-agent"]);
  });

  it("throttles repeated snapshot reconciliations, recovers after cooldown or clock step-back, and lets remove run scoped without waiting for slow polls", async () => {
    const { controller, account } = await fixture();
    const other = await controller.store.add("codex", "Other");
    await controller.store.prepare("slow-agent", "codex", other.id);
    await controller.store.prepare("target-agent", "codex", account.id);
    let releaseSlow!: () => void, slowStarted!: () => void;
    const enteredSlow = new Promise<void>(resolve => { slowStarted = resolve; });
    let slowMode = true;
    const ref = vi.fn((id: string) => ({
      refresh: async () => {
        if (id === "slow-agent" && slowMode) {
          slowStarted();
          await new Promise<void>(resolve => { releaseSlow = resolve; });
          return { agent: { id, status: "idle" } };
        }
        return id === "slow-agent" ? { agent: { id, status: "idle" } } : null;
      },
    }));
    const host = { agents: { ref } } as unknown as PaseoApi;
    const poll = controller.snapshot(host);
    await enteredSlow;
    // Removing `account` checks only `target-agent` and completes immediately even while `poll` is still stuck on `slow-agent`.
    await controller.remove(account.id, host);
    expect((await controller.store.read()).accounts.some(a => a.id === account.id)).toBe(false);
    releaseSlow();
    await poll;
    slowMode = false;
    const callsAfterPoll = ref.mock.calls.length;
    await controller.snapshot(host);
    expect(ref.mock.calls.length).toBe(callsAfterPoll);
    // Advancing past RECONCILE_INTERVAL or stepping the clock backward re-enables polling reconciliation.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await controller.snapshot(host);
      expect(ref.mock.calls.length).toBeGreaterThan(callsAfterPoll);
      const callsAfterCooldown = ref.mock.calls.length;
      vi.setSystemTime(Date.now() - 120_000);
      await controller.snapshot(host);
      expect(ref.mock.calls.length).toBeGreaterThan(callsAfterCooldown);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds per-binding lookup concurrency and deduplicates probes across concurrent background and scoped passes", async () => {
    const { controller, account } = await fixture();
    await controller.store.prepare("shared-agent", "codex", account.id);
    for (let i = 0; i < 8; i++) await controller.store.prepare(`agent-${i}`, "codex", "system-codex");
    let active = 0, peak = 0, sharedCalls = 0;
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => {
            if (id === "shared-agent") sharedCalls++;
            active++;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 15));
            active--;
            return id === "shared-agent" ? null : { agent: { id, status: "idle" } };
          },
        }),
      },
    } as unknown as PaseoApi;
    await Promise.all([controller.snapshot(host), controller.remove(account.id, host)]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(sharedCalls).toBe(1);
  });

  it("does not reuse a pre-registration probe null to delete a newly registered binding during forced removal", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.setDefault("codex", account.id);
    await controller.switcher(paseo).bindNewAgent("racing-agent", "codex");
    let resolveStale!: (value: null) => void, staleStarted!: () => void;
    const enteredStale = new Promise<void>(resolve => { staleStarted = resolve; });
    let calls = 0;
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: () => {
            calls++;
            if (calls === 1) {
              staleStarted();
              return new Promise<null>(resolve => { resolveStale = resolve; });
            }
            return Promise.resolve({ agent: { id, status: "idle" } });
          },
        }),
      },
    } as unknown as PaseoApi;
    const bgPoll = controller.snapshot(host);
    await enteredStale;
    await controller.observeAgentRegistration("racing-agent");
    // Forced removal must issue a fresh probe instead of joining the pre-registration probe that resolves to null.
    await expect(controller.remove(account.id, host)).rejects.toThrow(/used by an agent/);
    resolveStale(null);
    await bgPoll;
    expect(calls).toBe(2);
    expect((await controller.store.read()).bindings.map(b => b.agentId)).toEqual(["racing-agent"]);
  });

  it("does not reuse a pre-confirmation probe null after confirmLaunch confirms the binding", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.setDefault("codex", account.id);
    await controller.switcher(paseo).bindNewAgent("confirmed-agent", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken!;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "confirmed-agent.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    let resolveStale!: (value: null) => void, staleStarted!: () => void;
    const enteredStale = new Promise<void>(resolve => { staleStarted = resolve; });
    let calls = 0;
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: () => {
            calls++;
            if (calls === 1) {
              staleStarted();
              return new Promise<null>(resolve => { resolveStale = resolve; });
            }
            return Promise.resolve({ agent: { id, status: "idle" } });
          },
        }),
      },
    } as unknown as PaseoApi;
    const bgPoll = controller.snapshot(host);
    await enteredStale;
    expect(await controller.accountOf(host, "confirmed-agent", "codex")).toBe(account.id);
    // Forced removal after confirmLaunch must not reuse the pre-confirmation probe that resolves to null.
    await expect(controller.remove(account.id, host)).rejects.toThrow(/used by an agent/);
    resolveStale(null);
    await bgPoll;
    expect((await controller.store.read()).bindings[0]).toMatchObject({ agentId: "confirmed-agent", currentAccountId: account.id });
  });

  it("holds true daemon concurrency at 4 while stalled lookups remain pending and aborts queued forced lookups at the forced deadline", async () => {
    const { controller, account } = await fixture();
    for (let i = 0; i < 9; i++) await controller.store.prepare(`hung-${i}`, "codex", account.id);
    const dispatched: string[] = [];
    const resolvers = new Map<string, (value: null) => void>();
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: () => {
            dispatched.push(id);
            return new Promise<null>(resolve => { resolvers.set(id, resolve); });
          },
        }),
      },
    } as unknown as PaseoApi;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const removal = controller.remove(account.id, host);
      const outcome = removal.then(() => "ok", (error: Error) => error.message);
      await vi.waitFor(() => expect(dispatched).toHaveLength(4));
      // Even past PROBE_TIMEOUT_MS (5s), the 4 unresolved daemon requests still hold their slots so the daemon is not flooded.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dispatched).toHaveLength(4);
      // At 8s total, the forced pass hits FORCE_RECONCILE_TIMEOUT_MS, rejects, and drains queued waiters.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await outcome).toMatch(/Could not verify whether agents still use this account in time/);
      // When the 4 original daemon requests later settle to null, no queued lookups are dispatched and nothing is deleted.
      for (const resolve of resolvers.values()) resolve(null);
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatched).toHaveLength(4);
      expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
      expect((await controller.store.read()).accounts.some(a => a.id === account.id)).toBe(true);
      expect((await controller.store.read()).bindings).toHaveLength(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds waiting on an in-flight credential check during startLogin so sign-in does not start past the RPC deadline", async () => {
    const { controller, account } = await fixture();
    let probeStarted!: () => void;
    const enteredProbe = new Promise<void>(resolve => { probeStarted = resolve; });
    mocks.probeAccount.mockImplementationOnce(() => { probeStarted(); return new Promise(() => {}); });
    const pendingCheck = controller.checkAccount(account.id);
    void pendingCheck.catch(() => {});
    await enteredProbe;
    let waitingForCheck!: () => void;
    const enteredWait = new Promise<void>(resolve => { waitingForCheck = resolve; });
    mocks.usage.invalidate.mockImplementationOnce(() => { waitingForCheck(); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const signIn = controller.startLogin(paseo, account.id);
      const outcome = signIn.then(() => "ok", (error: Error) => error.message);
      await enteredWait;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatch(/account check is still in progress/i);
      expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns snapshot promptly when a multi-batch background reconciliation exceeds its wait budget", async () => {
    const { controller, account } = await fixture();
    for (let i = 0; i < 5; i++) await controller.store.prepare(`slow-${i}`, "codex", account.id);
    const resolvers = new Map<string, (value: null) => void>();
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: () => new Promise<null>(resolve => { resolvers.set(id, resolve); }),
        }),
      },
    } as unknown as PaseoApi;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const snap = controller.snapshot(host);
      await vi.waitFor(() => expect(resolvers.size).toBe(4));
      // Batch 1 finishes at 3s (below the 5s per-probe timeout); batch 2 (5th agent) starts at 3s.
      await vi.advanceTimersByTimeAsync(3_000);
      for (const id of ["slow-0", "slow-1", "slow-2", "slow-3"]) resolvers.get(id)!(null);
      await vi.waitFor(() => expect(resolvers.has("slow-4")).toBe(true));
      // At 5s total, snapshot() hits SNAPSHOT_RECONCILE_WAIT_MS and returns promptly while batch 2 is still in flight.
      await vi.advanceTimersByTimeAsync(2_000);
      const state = await snap;
      expect(state.bindings).toHaveLength(5);
      // Batch 2 finishes cleanly at 6s (3s into its own probe) and removes all 5 deleted bindings in the background.
      resolvers.get("slow-4")!(null);
      await vi.waitFor(async () => expect((await controller.store.read()).bindings).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent ensureRuntime integration checks", async () => {
    const { controller } = await fixture();
    let release!: () => void;
    mocks.reconcileIntegration.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = controller.ensureRuntime(paseo);
    const second = controller.ensureRuntime(paseo);
    await vi.waitFor(() => expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(1);
    await controller.ensureRuntime(paseo);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(2);
  });

  it("bounds snapshot launch confirmation when all semaphore slots are stalled and evicts timed-out queued probes", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    for (let i = 0; i < 4; i++) await controller.store.prepare(`stalled-${i}`, "codex", account.id);
    await controller.store.change(r => {
      r.bindings.push({ agentId: "confirm-me", provider: "codex", currentAccountId: null, pendingAccountId: null, launchAccountId: account.id, launchToken: "tok-c", status: "ready", error: null, registrationObserved: false, boundAt: new Date().toISOString() });
    });
    const other = await controller.add("codex", "Other");
    await controller.store.prepare("queued-target", "codex", other.id);
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "confirm-me.json"), JSON.stringify({ accountId: account.id, launchToken: "tok-c" }));
    const dispatched: string[] = [];
    const resolvers = new Map<string, (value: null) => void>();
    let fourReady!: () => void;
    const allFourDispatched = new Promise<void>(resolve => { fourReady = resolve; });
    const host = {
      agents: {
        ref: (id: string) => ({
          refresh: () => {
            dispatched.push(id);
            if (dispatched.length === 4) fourReady();
            return new Promise<null>(resolve => { resolvers.set(id, resolve); });
          },
        }),
      },
    } as unknown as PaseoApi;
    const realSetTimeout = globalThis.setTimeout;
    const pauseReal = (ms = 20) => new Promise<void>(resolve => { realSetTimeout(resolve, ms); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const snap = controller.snapshot(host);
      await allFourDispatched;
      // At 5s, snapshot's reconciliation wait ends (and queued probe for confirm-me times out & is evicted);
      // snapshot reads the receipt and enters confirmLaunch while all 4 stalled probes still hold their slots.
      await vi.advanceTimersByTimeAsync(5_000);
      await pauseReal();
      // At 10s, snapshot's shared confirmation deadline expires and snapshot() returns without hanging.
      await vi.advanceTimersByTimeAsync(5_000);
      const state = await snap;
      expect(state.bindings.find(b => b.agentId === "confirm-me")?.currentAccountId).toBeNull();
      // Also run a forced removal on a single binding while all 4 slots are still held: it hits the 5s per-probe timeout
      // (before the 8s outer timeout) and must evict its queued waiter so no abandoned lookup reaches the daemon.
      const removal = controller.remove(other.id, host).then(() => "ok", (error: Error) => error.message);
      await pauseReal();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await removal).toMatch(/used by an agent/i);
      // When the 4 stalled probes settle, neither confirm-me nor queued-target is dispatched as a zombie lookup.
      for (const resolve of resolvers.values()) resolve(null);
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatched).toEqual(["stalled-0", "stalled-1", "stalled-2", "stalled-3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects startLogin before launching the CLI when the shared RPC deadline expires", async () => {
    const { controller, account } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const deadline = Date.now() + 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(controller.startLogin(paseo, account.id, "device", deadline)).rejects.toThrow(/in time|too long/i);
      expect(accountFrom(await controller.store.read(), account.id).loginToken).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds slow reconcileLogins in snapshot and does not delete credentials in remove when store.queue stalls past deadline", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => {
      const a = accountFrom(r, account.id);
      a.loginToken = "tok-slow-login";
      a.login = { workspaceId: "ws", terminalId: "term" };
    });
    await mkdir(join(controller.store.root, "logins"), { recursive: true });
    await writeFile(join(controller.store.root, "logins", `${account.id}.json`), JSON.stringify({ loginToken: "tok-slow-login", exitCode: 0 }));
    let probeStarted!: () => void;
    const enteredProbe = new Promise<void>(resolve => { probeStarted = resolve; });
    mocks.probeAccount.mockImplementationOnce(() => { probeStarted(); return new Promise(() => {}); });
    const realSetTimeout = globalThis.setTimeout;
    const pauseReal = (ms = 20) => new Promise<void>(resolve => { realSetTimeout(resolve, ms); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const snap = controller.snapshot(paseo);
      await enteredProbe;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(snap).resolves.toMatchObject({ accounts: expect.any(Array) });
      // Also verify remove() refuses inside store.remove if store.queue was held past deadlineMs.
      const removable = await controller.add("codex", "Removable");
      let releaseQueue!: () => void;
      const blocker = controller.store.change(() => new Promise<void>(resolve => { releaseQueue = resolve; }));
      const deadline = Date.now() + 1_000;
      const removal = controller.remove(removable.id, paseo, deadline).then(() => "ok", (error: Error) => error.message);
      await pauseReal();
      await vi.advanceTimersByTimeAsync(1_500);
      releaseQueue();
      await blocker;
      expect(await removal).toMatch(/in time/i);
      expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
      expect((await controller.store.read()).accounts.some(a => a.id === removable.id)).toBe(true);
      // Once removeAccountCredentials has started before the deadline, passing the deadline during deletion must NOT report a verification timeout or skip cache invalidation.
      let releaseCreds!: () => void, credsEntered!: () => void;
      const enteredCreds = new Promise<void>(resolve => { credsEntered = resolve; });
      mocks.removeAccountCredentials.mockImplementationOnce(() => { credsEntered(); return new Promise<void>(resolve => { releaseCreds = resolve; }); });
      const activeRemoval = controller.remove(removable.id, paseo, Date.now() + 1_000);
      await enteredCreds;
      await vi.advanceTimersByTimeAsync(2_000);
      releaseCreds();
      await activeRemoval;
      expect(mocks.usage.invalidate).toHaveBeenCalledWith(removable.id);
      expect((await controller.store.read()).accounts.some(a => a.id === removable.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances store registrationEpoch on store.prepare so forced removal cannot reuse an older null probe", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => {
      r.bindings.push({ agentId: "prep-agent", provider: "codex", currentAccountId: null, pendingAccountId: null, launchAccountId: account.id, launchToken: "tok-prep", status: "ready", error: null, registrationObserved: false, boundAt: new Date().toISOString() });
    });
    let resolveStale!: (value: null) => void;
    let calls = 0;
    const host = {
      agents: {
        ref: () => ({
          refresh: () => {
            calls++;
            if (calls === 1) return new Promise<null>(resolve => { resolveStale = resolve; });
            return Promise.resolve({ agent: { provider: "codex", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null } });
          },
        }),
      },
    } as unknown as PaseoApi;
    const poll = controller.snapshot(host);
    await vi.waitFor(() => expect(calls).toBe(1));
    await controller.store.prepare("prep-agent", "codex", account.id);
    const removalOutcome = controller.remove(account.id, host).then(() => "ok", (error: Error) => error.message);
    await vi.waitFor(() => expect(calls).toBe(2));
    resolveStale(null);
    expect(await removalOutcome).toMatch(/used by an agent/i);
    await poll;
    expect((await controller.store.read()).bindings.find(b => b.agentId === "prep-agent")).toBeTruthy();
  });
});

describe("confirmation token lifecycle", () => {
  it("consumes a successful confirmation and never resurrects its receipt after integration is disabled", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("receipt-agent", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "receipt-agent.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    await controller.snapshot(paseo);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: account.id, launchToken: null });
    await controller.integration(paseo, false);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("receipt-agent", "codex", "system-codex");
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
    expect((await controller.store.read()).bindings[0].launchToken).toBeNull();
  });

  // Agents started with no app open (schedules, heartbeats, `paseo run`) are never confirmed by the app's polling.
  it("names the account an agent runs on, confirming an unconfirmed launch by its receipt", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    expect(await controller.accountOf(paseo, "never-bound", "codex")).toBe("system-codex");
    await controller.switcher(paseo).bindNewAgent("scheduled", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    // No receipt yet: the agent is on no known account, and nothing changes.
    expect(await controller.accountOf(paseo, "scheduled", "codex")).toBeNull();
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: null, launchToken: token });
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "scheduled.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    const starting = { agents: { ref: () => ({ refresh: async () => ({ agent: { status: "initializing" } }) }) } } as unknown as PaseoApi;
    expect(await controller.accountOf(starting, "scheduled", "codex")).toBeNull();
    expect(await controller.accountOf(paseo, "scheduled", "codex")).toBe(account.id);
    // Confirmed for good, as the app's polling would have done.
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: account.id, launchToken: null, registrationObserved: true });
    expect(await controller.accountOf(starting, "scheduled", "codex")).toBe(account.id);
  });

  // Paseo marks an agent "error" when a turn fails, before the plugin's turn_ended hook runs. The launcher writes the
  // receipt when it starts the CLI, so a matching receipt still names the account the agent started on.
  it("confirms a launch for failover after a failed turn left the agent in error, while the Accounts list still waits", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("failed-first", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "failed-first.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    const failed = { agents: { ref: () => ({ refresh: async () => ({ agent: { status: "error" } }) }) } } as unknown as PaseoApi;
    expect((await controller.snapshot(failed)).bindings[0].currentAccountId).toBeNull();
    expect(await controller.accountOf(failed, "failed-first", "codex")).toBe(account.id);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: account.id, launchToken: null });
  });

  it("offers the switch when an unconfirmed Codex agent's first turn fails on a used-up account", async () => {
    const root = await newRoot(), home = join(root, "account-switcher");
    vi.stubEnv("PASEO_HOME", root);
    const on = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
    const dispose = contribute({ handle: () => {}, before: () => () => {}, on: (name: string, handler: never) => { on.set(name, handler); return () => {}; } } as never);
    try {
      const store = new AccountStore(home);
      // Initialized by the plugin's controller: wait for its registry before changing it.
      await vi.waitFor(async () => expect((await store.read()).accounts.length).toBeGreaterThan(0));
      const work = await store.add("codex", "Work"), second = await store.add("codex", "Second"), token = "launch-token";
      await store.change(r => {
        r.integration.enabled = true;
        for (const a of r.accounts) a.authStatus = "ready";
        r.bindings.push({ agentId: "agent-1", provider: "codex", currentAccountId: null, pendingAccountId: null, launchAccountId: work.id, launchToken: token, status: "ready", error: null, registrationObserved: true });
      });
      await mkdir(join(home, "receipts"), { recursive: true });
      await writeFile(join(home, "receipts", "agent-1.json"), JSON.stringify({ accountId: work.id, launchToken: token }));
      const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
      const reading = (accountId: string, usedPercent: number) => ({ accountId, provider: "codex", status: "ok", plan: null, fetchedAt: null, checkedAt: resetsAt, nextRetryAt: null, error: null,
        windows: [{ id: "5h", label: "5 hours", usedPercent, windowDurationMins: 300, resetsAt, scope: "account" }] });
      mocks.usage.refresh.mockResolvedValue([reading(work.id, 100), reading(second.id, 10)]);
      const appended: { id: string; data: unknown }[] = [];
      const host = { agents: { ref: () => ({
        refresh: async () => ({ agent: { id: "agent-1", provider: "codex", status: "error", model: null } }),
        timeline: { append: async (item: { id: string; data: unknown }) => { appended.push(item); return {}; } },
      }) } };
      await on.get("agent.turn_ended")!({ agent: { id: "agent-1", provider: "codex" }, turnId: "turn-1", outcome: { kind: "failed", error: { message: "Usage limit reached" } }, timeline: [] }, { paseo: host });
      expect(appended).toEqual([expect.objectContaining({ id: "account-failover-agent-1-turn-1", data: expect.objectContaining({ state: "offered", from: "Work", fromId: work.id, toId: second.id }) })]);
      expect((await store.read()).bindings[0]).toMatchObject({ currentAccountId: work.id, launchToken: null });
    } finally { await dispose(); vi.unstubAllEnvs(); }
  });

  it("refuses a switch for an agent Paseo no longer has with a message written for the user", async () => {
    const { controller, account } = await fixture();
    const gone = { agents: { ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi;
    const refusal = controller.switcher(gone).prepare("gone", account.id);
    await expect(refusal).rejects.toThrow("Agent not found.");
    await expect(refusal).rejects.toBeInstanceOf(SwitchRefusal);
  });

  it("does not confirm a pending receipt while integration is disabled", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; r.defaults.codex = account.id; });
    await controller.switcher(paseo).bindNewAgent("disabled-agent", "codex");
    const token = (await controller.store.read()).bindings[0].launchToken;
    await mkdir(join(controller.store.root, "receipts"), { recursive: true });
    await writeFile(join(controller.store.root, "receipts", "disabled-agent.json"), JSON.stringify({ accountId: account.id, launchToken: token }));
    await controller.store.change(r => { r.integration.enabled = false; });
    expect((await controller.snapshot(paseo)).bindings[0].currentAccountId).toBeNull();
  });
});

describe("default account authentication", () => {
  it("retains a verified identity on temporary credential-access failure and recovers on the next check", async () => {
    const { controller, account } = await fixture();
    const ready = await controller.checkAccount(account.id);
    mocks.usage.invalidate.mockClear();
    mocks.probeAccount.mockResolvedValueOnce({ identityKey: null, email: null, plan: null, authStatus: "error" });
    const unavailable = await controller.checkAccount(account.id);
    expect(unavailable).toMatchObject({ identityKey: ready.identityKey, email: ready.email, plan: ready.plan, generation: ready.generation, authStatus: "error" });
    expect(mocks.usage.invalidate).not.toHaveBeenCalled();
    expect(await controller.checkAccount(account.id)).toMatchObject({ identityKey: ready.identityKey, generation: ready.generation, authStatus: "ready" });
  });
  it("requires a ready official auth probe before persisting a new default", async () => {
    const { controller, account } = await fixture();
    mocks.probeAccount.mockResolvedValueOnce({ identityKey: null, email: null, plan: null, authStatus: "needs_auth" });
    await expect(controller.setDefault("codex", account.id)).rejects.toThrow(/Sign in|authentication/);
    expect((await controller.store.read()).defaults.codex).toBeNull();
    await controller.setDefault("codex", account.id);
    expect((await controller.store.read()).defaults.codex).toBe(account.id);
  });
});

describe("owned login artifact removal", () => {
  it("refuses redirected cleanup parents before deleting credentials or unrelated files", async () => {
    const { controller, account } = await fixture();
    const unrelated = join(controller.store.root, "unrelated"); await mkdir(unrelated);
    await mkdir(join(unrelated, account.id)); await writeFile(join(unrelated, account.id, "keep"), "preserve");
    await symlink(unrelated, join(controller.store.root, "login"));
    await expect(controller.remove(account.id)).rejects.toThrow(/redirected/);
    expect(mocks.removeAccountCredentials).not.toHaveBeenCalled();
    expect(accountFrom(await controller.store.read(), account.id).id).toBe(account.id);
    await expect(access(join(unrelated, account.id, "keep"))).resolves.toBeUndefined();
  });

  it("removes this account's login directory and receipt while preserving sibling and symlink targets", async () => {
    const { controller, account } = await fixture();
    const directory = join(controller.store.root, "login", account.id), sibling = join(controller.store.root, "login", "other-account");
    await mkdir(directory, { recursive: true }); await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "keep"), "preserve"); await symlink(sibling, join(directory, "shared"));
    await loginReceipt(controller.store.root, account.id, "completed"); await loginReceipt(controller.store.root, "other-account", "keep");
    await controller.remove(account.id);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(controller.store.root, "logins", `${account.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(sibling, "keep"))).resolves.toBeUndefined();
    await expect(access(join(controller.store.root, "logins", "other-account.json"))).resolves.toBeUndefined();
  });
});

describe("live integration reconciliation", () => {
  it("rechecks actual provider ownership on each action while caching expensive discovery", async () => {
    const { controller } = await fixture();
    await controller.ensureRuntime(paseo); await controller.ensureRuntime(paseo);
    expect(mocks.prepareRuntime).toHaveBeenCalledExactlyOnceWith(paseo, controller.store);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(2);
  });

  it("blocks apply before its auth probe when commands have drifted since discovery", async () => {
    const { controller, account } = await fixture(); await controller.ensureRuntime(paseo);
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("drift-agent", "codex", account.id);
    mocks.reconcileIntegration.mockImplementationOnce(async () => {
      await controller.store.change(r => { r.integration = { ...r.integration, enabled: false, error: "Provider ownership changed" }; });
    });
    await expect(controller.switcher(paseo).apply("drift-agent")).rejects.toThrow(/integration/i);
    expect(mocks.probeAccount).not.toHaveBeenCalled();
    expect((await controller.store.read()).bindings[0].launchToken).toBeNull();
  });

  it("rechecks ownership immediately before reload when drift occurs during the auth probe", async () => {
    const { controller, account } = await fixture();
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare("late-drift-agent", "codex", account.id);
    let drifted = false;
    mocks.probeAccount.mockImplementationOnce(async () => { drifted = true; return { identityKey: "fixture-account", email: null, plan: "plus", authStatus: "ready" }; });
    mocks.reconcileIntegration.mockImplementation(async () => {
      if (!drifted) return;
      await controller.store.change(r => {
        r.integration = { ...r.integration, enabled: false, error: "Provider ownership changed" };
        for (const binding of r.bindings) { binding.launchToken = null; binding.currentAccountId = null; binding.status = "error"; }
      });
    });
    await expect(controller.switcher(paseo).apply("late-drift-agent")).rejects.toThrow(/integration/i);
    expect(mocks.reconcileIntegration).toHaveBeenCalledTimes(2);
    expect((await controller.store.read()).bindings[0]).toMatchObject({ currentAccountId: null, launchToken: null, status: "error" });
  });
});

describe("native reload", () => {
  // A Paseo terminal names the app's CLI in PASEO_CLI; each test here chooses the CLI itself.
  beforeEach(() => { vi.stubEnv("PASEO_CLI", undefined); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function lazyFixture(agentId: string) {
    const home = await newRoot(), controller = await start(join(home, "account-switcher"));
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "0.0.0.0:6767" } }));
    const account = await controller.store.add("codex", "Managed"); await mkdir(account.home, { recursive: true });
    await controller.store.change(r => { r.integration.enabled = true; });
    await controller.store.prepare(agentId, "codex", account.id);
    // Paseo 0.11 returns from reload before the CLI exists; only first use spawns the launcher.
    const commands = vi.fn(async () => {
      const binding = (await controller.store.read()).bindings[0];
      await mkdir(join(controller.store.root, "receipts"), { recursive: true });
      await writeFile(join(controller.store.root, "receipts", `${agentId}.json`), JSON.stringify({ accountId: binding.launchAccountId, launchToken: binding.launchToken }));
      return { commands: [] };
    });
    const lazy = { agents: { ref: () => ({ refresh: async () => ({ agent: { provider: "codex", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null } }), commands }) } } as unknown as PaseoApi;
    return { controller, account, commands, lazy };
  }

  it("starts a lazily launched provider CLI so the switch can confirm its receipt", async () => {
    const { controller, account, commands, lazy } = await lazyFixture("lazy-agent");
    await expect(controller.switcher(lazy).apply("lazy-agent")).resolves.toMatchObject({ currentAccountId: account.id, status: "ready" });
    expect(mocks.execFile).toHaveBeenCalledWith("paseo", ["agent", "reload", "lazy-agent", "--json", "--host", "127.0.0.1:6767"], expect.anything(), expect.any(Function));
    expect(commands).toHaveBeenCalledTimes(1);
  });

  it("reloads with the daemon's own CLI and without the runtime switches of the plugin's process", async () => {
    // An older desktop install linked `paseo` to the app executable, which ELECTRON_RUN_AS_NODE turns into plain Node.
    const cli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
    vi.stubEnv("PASEO_CLI", cli); vi.stubEnv("ELECTRON_RUN_AS_NODE", "1"); vi.stubEnv("PASEO_NODE_ENV", "production");
    const { controller, account, lazy } = await lazyFixture("cli-agent");
    await expect(controller.switcher(lazy).apply("cli-agent")).resolves.toMatchObject({ currentAccountId: account.id, status: "ready" });
    expect(mocks.execFile).toHaveBeenCalledWith(cli, ["agent", "reload", "cli-agent", "--json", "--host", "127.0.0.1:6767"], expect.anything(), expect.any(Function));
    const { env } = mocks.execFile.mock.calls.find(call => call[0] === cli)![2] as { env: NodeJS.ProcessEnv };
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(env).not.toHaveProperty("PASEO_NODE_ENV");
    expect(env).toMatchObject({ PATH: process.env.PATH, PASEO_CLI: cli });
  });

  it.each(["ENOENT", "EACCES"])("falls back to PATH when the CLI in PASEO_CLI cannot start (%s)", async code => {
    // A daemon started from the app's terminal inherits the variable and can outlive the app it names.
    const stale = "/Applications/Moved.app/Contents/Resources/bin/paseo";
    vi.stubEnv("PASEO_CLI", stale);
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(Object.assign(new Error(`spawn ${code}`), { code, stderr: "" }));
    });
    const { controller, account, lazy } = await lazyFixture("stale-agent");
    await expect(controller.switcher(lazy).apply("stale-agent")).resolves.toMatchObject({ currentAccountId: account.id, status: "ready" });
    expect(mocks.execFile.mock.calls.map(call => call[0])).toEqual([stale, "paseo"]);
  });

  it("runs no second CLI after the one in PASEO_CLI ran and failed", async () => {
    const cli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
    vi.stubEnv("PASEO_CLI", cli);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(Object.assign(new Error("Command failed"), { code: 1, signal: null, stderr: "refused" }));
    });
    const { controller, lazy } = await lazyFixture("refused-agent");
    await expect(controller.switcher(lazy).apply("refused-agent")).rejects.toThrow(/^The native agent reload failed\./);
    expect(new Set(mocks.execFile.mock.calls.map(call => call[0]))).toEqual(new Set([cli]));
  });

  it("reloads through the SDK on a host that has it, and starts no CLI", async () => {
    vi.stubEnv("PASEO_CLI", "/nowhere/paseo");
    const { controller, account, commands, lazy } = await lazyFixture("sdk-agent");
    const reload = vi.fn(async () => null);
    const handle = lazy.agents.ref("sdk-agent");
    const withSdk = { agents: { ref: () => ({ ...handle, reload }) } } as unknown as PaseoApi;
    await expect(controller.switcher(withSdk).apply("sdk-agent")).resolves.toMatchObject({ currentAccountId: account.id, status: "ready" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(commands).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls.filter(call => (call[1] as string[]).includes("reload"))).toEqual([]);
  });
  it("keeps the cause of an SDK reload's failure in the plugin log and tries no CLI after it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, lazy } = await lazyFixture("sdk-broken");
    const handle = lazy.agents.ref("sdk-broken");
    const withSdk = { agents: { ref: () => ({ ...handle, reload: async () => { throw new Error("session at /private/path\nwould not open"); } }) } } as unknown as PaseoApi;
    await expect(controller.switcher(withSdk).apply("sdk-broken")).rejects.toThrow(/^The native agent reload failed\. Check the agent status and try again\.$/);
    expect(log).toHaveBeenCalledWith("Native reload of agent sdk-broken failed: session at /private/path would not open");
    expect(mocks.execFile.mock.calls.filter(call => (call[1] as string[]).includes("reload"))).toEqual([]);
  });
  it("keeps the cause of a failed reload in the plugin log and out of the chat", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const stderr = "node:internal/modules/cjs/loader:1575\n  throw err;\n  ^\n\n\u001b[31mError: Cannot find module '/agent'\u001b[39m\n";
      (args.at(-1) as (error: Error) => void)(Object.assign(new Error("Command failed"), { code: 1, signal: null, stderr }));
    });
    const { controller, lazy } = await lazyFixture("broken-agent");
    await expect(controller.switcher(lazy).apply("broken-agent")).rejects.toThrow(/^The native agent reload failed\. Check the agent status and try again\.$/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/broken-agent with paseo failed \(code 1\): .* Error: Cannot find module '\/agent'$/));
  });
});
