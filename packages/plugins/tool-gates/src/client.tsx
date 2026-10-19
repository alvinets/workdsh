import * as React from 'react';
import { useEffect, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { createToolGatesClient } from './client/management.js';
import type { ToolGatesState } from './shared.js';

const style = { maxWidth: 480, color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' };
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' } as const;
const labelStyle = { display: 'flex', flexDirection: 'column', gap: 4 } as const;
const titleStyle = { fontSize: 15, fontWeight: 600 } as const;
const descStyle = { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } as const;
const unavailableStyle = { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } as const;

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${checked ? '停用' : '启用'}${label}`}
      disabled={disabled}
      onClick={onChange}
      style={{
        display: 'flex', alignItems: 'center', flex: 'none',
        width: 40, height: 22, padding: 2, margin: 0, border: 0, borderRadius: 999,
        background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-interactive-bg-hover)',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        opacity: disabled ? 0.38 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background .15s',
      }}
    >
      <span aria-hidden="true" style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: '#fff' }} />
    </button>
  );
}

function ToolGatesSection(_props: PropsRuntime<'settings.section'>) {
  const [state, setState] = useState<ToolGatesState>({ computerUse: false, browserTools: false });
  const [available, setAvailable] = useState<{ computerUse: boolean; browserTools: boolean }>({ computerUse: false, browserTools: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const lifetime = new AbortController();
    const load = async () => {
      try {
        const client = createToolGatesClient({} as Context, lifetime.signal);
        const result = await client.get();
        if (!lifetime.signal.aborted) {
          setState(result.state);
          setAvailable(result.available);
        }
      } catch (cause) {
        if (!lifetime.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败。');
      } finally {
        if (!lifetime.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => { lifetime.abort(); };
  }, []);

  const toggle = async (key: keyof ToolGatesState) => {
    setBusy(true); setError('');
    try {
      const client = createToolGatesClient({} as Context);
      const next = await client.set({ [key]: !state[key] });
      setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally { setBusy(false); }
  };

  if (loading) return <section style={style}><p role="status">正在读取…</p></section>;

  return (
    <section style={style} data-testid="workdsh-tool-gates">
      <h1 style={{ fontSize: 24, marginTop: 0 }}>高级工具</h1>
      <p style={{ color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7 }}>
        按需启用扩展工具族。默认关闭以节省工具预算；运行时即时生效，无需重启。
      </p>
      <div style={{ marginTop: 20 }}>
        {/* computerUse row */}
        <div style={rowStyle}>
          <div style={labelStyle}>
            <span style={titleStyle}>计算机控制</span>
            <span style={descStyle}>启用 cua_driver_native 工具族，允许助手直接操控桌面。</span>
            {!available.computerUse && <span style={unavailableStyle}>当前未挂载该工具族。</span>}
          </div>
          <Switch
            checked={state.computerUse}
            onChange={() => void toggle('computerUse')}
            disabled={!available.computerUse || busy}
            label="计算机控制"
          />
        </div>
        {/* browserTools row */}
        <div style={rowStyle}>
          <div style={labelStyle}>
            <span style={titleStyle}>浏览器工具</span>
            <span style={descStyle}>启用 playwright-mcp 工具族，允许助手操控浏览器。</span>
            {!available.browserTools && <span style={unavailableStyle}>当前未挂载该工具族。</span>}
          </div>
          <Switch
            checked={state.browserTools}
            onChange={() => void toggle('browserTools')}
            disabled={!available.browserTools || busy}
            label="浏览器工具"
          />
        </div>
      </div>
      {error && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', marginTop: 12 }}>{error}</p>}
    </section>
  );
}

export const name = 'workdsh-tool-gates-client';
export const inject = ['slots'];

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'workdsh-tool-gates', label: '高级工具', order: 19,
  }, ToolGatesSection));
}
