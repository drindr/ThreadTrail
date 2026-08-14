/**
 * Ambient declarations for the DeepSeek Harness packages the plugin consumes
 * at runtime. The harness provides these modules to plugins; the workspace
 * does not install them, so we type only the small surfaces we use.
 */

declare module '@deepseek-ai/dsh-tools' {
  /** Define an agent tool (the harness binds the definition at registration). */
  export function defineTool(def: unknown): unknown;
}

declare module '@deepseek-ai/dsh-home-paths' {
  /** Canonical harness home path builder ($DSH_HOME, or ~/.dsh). */
  export function dshHomePath(...segments: string[]): string;
}
