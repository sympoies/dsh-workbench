import { useState } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { workbenchIdentity } from './identity.js';

type HandoffActionProps = PropsRuntime<'conversation.session.header.utilities'>;
const versionSummary = [
  `Workbench ${workbenchIdentity.release.version} (${workbenchIdentity.status})`,
  `DSH ${workbenchIdentity.components.dsh.package.version}`,
  `runtime-kit ${workbenchIdentity.components.runtimeKit.source.commit}`,
  `TUI ${workbenchIdentity.components.tui.package.version}`,
  workbenchIdentity.contractDigest,
].join(' | ');

/** Copy only the opaque Session identity; the other interface may resume after Web Host exit. */
function HandoffAction({ sessionId }: HandoffActionProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
      setCopied(false);
    }
  };
  return (
    <span>
      <button type="button" onClick={() => void copy()} aria-label="Copy Session ID for TUI"
        title={versionSummary}>
        {copied ? 'Session ID copied' : 'Copy Session ID'}
      </button>
      <span role="status">
        {failed ? 'Could not copy the Session ID.' : copied ? 'Stop Web Host before resuming in TUI.' : ''}
      </span>
    </span>
  );
}

export const inject = ['slots'];

/** Add a handoff affordance while leaving official conversation and approvals intact. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'dsh-workbench-handoff',
      order: 100,
    }, HandoffAction));
}
