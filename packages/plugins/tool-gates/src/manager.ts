import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { ToolGatesService, ToolGatesState, ToolGatesAvailable } from './shared.js';
import { toolGatesDomainSpec, type ToolGatesSettings } from './storage.js';

interface BrowserToolsControl {
  setToolsEnabled(agent: Agent, enabled: boolean): Promise<void>;
}

declare module '@deepseek-ai/cordis' { interface Context { workdshToolGates: ToolGatesService; } }

const COMPUTER_USE_PREFIX = 'cua_driver_native__';

/** Default both families off; apply deny masks on agent/created and for existing agents. */
const defaultSettings = (): ToolGatesSettings => ({
  computerUse: false,
  browserTools: false,
  updatedAt: new Date().toISOString(),
});

export class ToolGatesManager extends Service implements ToolGatesService {
  static inject = ['tools', 'agents', 'storageDomain', 'connection'];

  private settingsTable?: KvTable<string, ToolGatesSettings>;
  private browser?: BrowserToolsControl;
  private readonly agentDisposers = new WeakMap<Agent, Map<string, () => void>>();
  private readonly agentCleanup = new WeakSet<Agent>();
  private readonly liveDisposers = new Set<() => void>();
  private readonly knownNames = new Set<string>();
  private applying = false;

  constructor(ctx: Context) { super(ctx, 'workdshToolGates'); }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(toolGatesDomainSpec);
    this.ctx.effect(() => () => domain.close(), 'workdshToolGates.domainClose');
    this.settingsTable = domain.table('settings');

    // Backfill default if no row exists
    const current = this.settingsTable.get('global');
    if (!current) {
      await this.settingsTable.put('global', defaultSettings());
    }

    const ctx = this.ctx as unknown as {
      inject(deps: string[], callback: (injected: { workdshBrowserSession: BrowserToolsControl }) => void): unknown;
    };
    ctx.inject(['workdshBrowserSession'], injected => {
      this.browser = injected.workdshBrowserSession;
      void this.reapplyAll().catch(error => {
        this.ctx.logger.warn(`workdsh-tool-gates: browser reapply failed: ${String(error)}`);
      });
    });

    this.ctx.on('agent/created', ({ agent }) => {
      void this.applyForAgent(agent).catch(error => {
        this.ctx.logger.warn(`workdsh-tool-gates: apply failed: ${String(error)}`);
      });
      return undefined;
    });
    this.ctx.on('tools/change', () => {
      void this.reapplyAll().catch(error => {
        this.ctx.logger.warn(`workdsh-tool-gates: reapply failed: ${String(error)}`);
      });
      return undefined;
    });
    for (const agent of this.ctx.agents.list()) {
      await this.applyForAgent(agent);
    }

    this.ctx.effect(() => () => this.disposeAll(), 'workdshToolGates.disposeAll');
  }

  async get(): Promise<{ state: ToolGatesState; available: ToolGatesAvailable }> {
    const row = this.settingsTable!.get('global');
    const names = new Set(this.knownNames);
    for (const schema of this.ctx.tools.schemas()) names.add(schema.name);
    for (const agent of this.ctx.agents.list()) {
      for (const schema of this.ctx.tools.schemas(agent)) names.add(schema.name);
    }
    const hasFamily = (prefix: string) => {
      for (const name of names) if (name.startsWith(prefix)) return true;
      return false;
    };
    return {
      state: { computerUse: row?.computerUse ?? false, browserTools: row?.browserTools ?? false },
      available: {
        computerUse: hasFamily(COMPUTER_USE_PREFIX),
        browserTools: this.browser !== undefined,
      },
    };
  }

  getSync(): { state: ToolGatesState } {
    const row = this.settingsTable?.get('global');
    return {
      state: {
        computerUse: row?.computerUse ?? false,
        browserTools: row?.browserTools ?? false,
      },
    };
  }

  async set(input: Partial<ToolGatesState>): Promise<ToolGatesState> {
    const current = this.settingsTable!.get('global') ?? defaultSettings();
    const next: ToolGatesSettings = {
      computerUse: input.computerUse ?? current.computerUse,
      browserTools: input.browserTools ?? current.browserTools,
      updatedAt: new Date().toISOString(),
    };
    await this.settingsTable!.put('global', next);
    await this.reapplyAll();
    return { computerUse: next.computerUse, browserTools: next.browserTools };
  }

  private async applyForAgent(agent: Agent): Promise<void> {
    const row = this.settingsTable!.get('global') ?? defaultSettings();
    if (!this.applying) {
      this.applying = true;
      try {
        const previous = this.agentDisposers.get(agent);
        if (previous) {
          for (const disposer of previous.values()) {
            disposer();
            this.liveDisposers.delete(disposer);
          }
          previous.clear();
        }

        const familyDisposers = new Map<string, () => void>();
        this.agentDisposers.set(agent, familyDisposers);

        // Only inherited global tools are restrictable; the browser MCP family
        // is mounted or unmounted by workdsh-browser-session instead.
        const names = this.ctx.tools.schemas(agent).map(t => t.name);
        for (const name of names) this.knownNames.add(name);
        const namesFor = (prefix: string) => names.filter(n => n.startsWith(prefix));
        const deny = (family: string, denied: string[]) => {
          if (denied.length === 0) return;
          const disposer = agent.ctx.tools.restrict({ deny: denied });
          familyDisposers.set(family, disposer);
          this.liveDisposers.add(disposer);
        };

        if (!row.computerUse) deny('computerUse', namesFor(COMPUTER_USE_PREFIX));

        // Disposing the agent scope must also release the deny effects; otherwise
        // liveDisposers would retain a closure for every disposed agent.
        if (!this.agentCleanup.has(agent) && typeof agent.ctx.effect === 'function') {
          this.agentCleanup.add(agent);
          agent.ctx.effect(() => () => {
            const current = this.agentDisposers.get(agent);
            if (!current) return;
            for (const disposer of current.values()) {
              disposer();
              this.liveDisposers.delete(disposer);
            }
            current.clear();
          }, 'workdshToolGates.agentDispose');
        }
      } finally {
        this.applying = false;
      }
    }
    if (this.browser !== undefined) {
      await this.browser.setToolsEnabled(agent, row.browserTools);
    }
  }

  private async reapplyAll(): Promise<void> {
    await Promise.all(this.ctx.agents.list().map(agent => this.applyForAgent(agent)));
  }

  private disposeAll(): void {
    for (const disposer of this.liveDisposers) disposer();
    this.liveDisposers.clear();
  }
}
