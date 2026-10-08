import * as React from 'react';
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { HW_WORDMARK } from '../wordmark.generated.js';

/**
 * HAOWISE Λ monogram. The viewBox matches the shell fish mark so callers that
 * size by width keep their existing layout, and the fixed blue reads on both
 * themes without a variant.
 */
function Lambda({ size, className }: { size: number; className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={(size * 17.04) / 23.16}
      className={className}
      viewBox="0 0 23.16 17.04"
      fill="none"
      aria-hidden="true"
      focusable={false}
    >
      <path
        d="M11.58 1.6 2.6 15.5M11.58 1.6l8.98 13.9"
        stroke="#1F5FA0"
        strokeWidth="3.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandName() {
  return (
    <span role="img" aria-label="HAOWISE" style={{ display: 'inline-flex', alignItems: 'center' }}>
      <img src={HW_WORDMARK} alt="" aria-hidden="true" style={{ display: 'block', height: 24, width: 'auto' }} />
    </span>
  );
}

export function BrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <Lambda size={size} />;
}

export function HeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <Lambda size={size} className={className} />;
}

export function DiagnosticsMark() {
  return <span aria-hidden>H</span>;
}