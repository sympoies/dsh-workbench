import type { ChildProcess } from 'node:child_process';

export async function stopTerminal(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  const terminal = child;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (terminal.pid) process.kill(-terminal.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (terminal.exitCode !== null || terminal.signalCode !== null) {
    signalGroup('SIGKILL');
    return;
  }
  await new Promise<void>((resolveStopped, reject) => {
    let settled = false;
    const send = (signal: NodeJS.Signals) => {
      try { signalGroup(signal); } catch (error) { finish(error as Error); }
    };
    const term = setTimeout(() => send('SIGTERM'), 5_000);
    const kill = setTimeout(() => send('SIGKILL'), 10_000);
    const deadline = setTimeout(() => finish(new Error('TUI process group did not stop within 15 seconds')), 15_000);
    const onExit = () => { send('SIGKILL'); finish(); };
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(deadline);
      terminal.off('exit', onExit);
      if (error) reject(error); else resolveStopped();
    }
    terminal.once('exit', onExit);
    if (terminal.exitCode !== null || terminal.signalCode !== null) onExit();
    else terminal.stdin?.write('\x03\x03');
  });
}
