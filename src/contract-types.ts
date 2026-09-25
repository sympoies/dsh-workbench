export interface WorkbenchContract {
  schemaVersion: number;
  release: { version: string; tag: string };
  status: string;
  runtime: { node: string; pnpm: string; platforms: string[] };
  components: Record<'dsh' | 'runtimeKit' | 'tui', {
    source: { url: string; tag?: string; commit: string; tree: string };
    package: { name: string; version: string; integrity: string };
    toolchain: { node: string; pnpm?: string };
    peerOverrides?: { workingActivity: string; react: string };
    compatibilityPatch?: { path: string; sha256: string };
    status: string;
  }>;
  acceptance: Record<'runtimeKit' | 'tui' | 'web' | 'handoff', {
    status: string;
    evidence: Array<{ platform: string; url: string }>;
  }>;
}
