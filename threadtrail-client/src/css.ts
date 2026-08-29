/**
 * The panel's stylesheet, injected as an owned `<style data-plugin>` element.
 * Theme-aware: uses the shell's `--dsw-alias-*` variables where they exist,
 * with light-theme-safe fallbacks; syntax token colors flip under
 * `body[data-ds-dark-theme]`.
 */
export const CSS = `
.ddb-root{display:flex;flex-direction:column;height:100%;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary,#1c1c1e)}
.ddb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-title{display:flex;flex-direction:column;gap:2px}
.ddb-title-main{font-weight:600;letter-spacing:.02em}
.ddb-title-sub{font-size:10px;opacity:.55}
.ddb-header-actions{display:flex;gap:4px}
.ddb-iconbtn{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;flex:none}
.ddb-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-iconbtn:disabled{opacity:.35;cursor:default}
.ddb-iconbtn:disabled:hover{background:none}
.ddb-body{flex:1;overflow-y:auto;padding:8px 12px 16px}
.ddb-note{opacity:.6;padding:12px 4px;line-height:1.5;font-size:12px}
.ddb-error{color:var(--dsw-alias-state-error-primary,#d9534f)}
.ddb-empty{opacity:.6;padding:16px 12px;font-size:12px}
.ddb-group-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin:10px 0 4px}

/* compare bar */
.ddb-compare{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.ddb-compare-slot{font-family:ui-monospace,monospace;font-size:11px;border:1px dashed var(--dsw-alias-border-l2,#333);border-radius:6px;padding:2px 8px;min-width:56px;text-align:center;opacity:.7;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-compare-from{border-style:solid;opacity:1;box-shadow:inset 3px 0 0 #4f8cff}
.ddb-compare-to{border-style:solid;opacity:1;box-shadow:inset 3px 0 0 #2ea043}
.ddb-compare-arrow{opacity:.5}

/* record list */
.ddb-records{display:flex;flex-direction:column;gap:2px;max-height:38vh;overflow-y:auto;margin-bottom:4px}
.ddb-record{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;padding:5px 8px;cursor:pointer;color:inherit;user-select:none}
.ddb-record:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-record-static{cursor:default;opacity:.75}
.ddb-record-static:hover{background:none}
.ddb-record-from{border-color:var(--dsw-alias-border-l2,#333);background:rgba(79,140,255,.10)}
.ddb-record-to{border-color:var(--dsw-alias-border-l2,#333);background:rgba(46,160,67,.10)}
.ddb-record-chips{display:flex;gap:3px;flex:none}
.ddb-chip{width:18px;height:18px;font-size:9px;line-height:1;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:4px;background:none;color:inherit;opacity:.45;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center}
.ddb-chip:hover{opacity:.9}
.ddb-chip-from-on{opacity:1;background:rgba(79,140,255,.30);border-color:transparent}
.ddb-chip-to-on{opacity:1;background:rgba(46,160,67,.30);border-color:transparent}
.ddb-record-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ddb-record-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-record-dim{opacity:.6;font-style:italic}
.ddb-record-meta{font-size:10px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-record-sha{font-family:ui-monospace,monospace;font-size:10px;opacity:.6;flex:none}

/* subfolder repo picker */
.ddb-rootbar{display:flex;align-items:center;gap:6px;border:1px dashed var(--dsw-alias-border-l2,#333);border-radius:8px;padding:4px 8px;margin-bottom:6px}
.ddb-rootbar-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.5;flex:none}
.ddb-rootbar-path{font-family:ui-monospace,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-rootsel{flex:1;min-width:0;background:var(--dsw-alias-bg-base,#ffffff);color:inherit;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:6px;font-family:ui-monospace,monospace;font-size:11px;padding:2px 4px}
.ddb-rootsel:focus{outline:none;border-color:var(--dsw-alias-border-l3,#444)}
.ddb-back{background:none;border:none;color:inherit;cursor:pointer;opacity:.7;padding:2px 0;font-size:12px;white-space:nowrap}
.ddb-back:hover{opacity:1}
.ddb-subrepos-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:11px}
.ddb-candidates{display:flex;flex-direction:column;gap:2px;margin-bottom:4px}
.ddb-candidate{display:flex;width:100%;text-align:left;background:none;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;padding:6px 8px;cursor:pointer;color:inherit}
.ddb-candidate:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-candidate-path{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}

/* diff summary */
.ddb-diff-summary{display:flex;align-items:center;gap:10px;font-size:11px;opacity:.85;margin-bottom:6px}
.ddb-stat-add{color:#2ea043}
.ddb-stat-del{color:#f85149}
.ddb-refreshing{font-size:10px;opacity:.5;font-style:italic;white-space:nowrap}
.ddb-diff-truncated{font-size:10px;color:#b58900}

/* file diff */
.ddb-opfile{border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;margin-bottom:8px;overflow:hidden}
.ddb-opfile-head{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}
.ddb-opfile-toggle{cursor:pointer;user-select:none}
.ddb-opfile-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.10))}
.ddb-chevron{display:inline-flex;flex:none;align-items:center;opacity:.6;transition:transform .12s ease}
.ddb-chevron-collapsed{transform:rotate(-90deg)}
.ddb-opfile-path{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}
.ddb-opfile-stats{font-size:10px;opacity:.6;white-space:nowrap}
.ddb-status{border-radius:4px;padding:0 4px;opacity:1}
.ddb-status-added{background:rgba(46,160,67,.20)}
.ddb-status-deleted{background:rgba(248,81,73,.20)}
.ddb-status-renamed{background:rgba(229,192,123,.20)}
.ddb-status-modified{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08))}
.ddb-diff{font-family:ui-monospace,monospace;font-size:11px;line-height:1.45}
.ddb-hunk-head{padding:2px 8px;font-size:10px;opacity:.55;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));border-top:1px solid var(--dsw-alias-border-l1,#2a2a2a);user-select:none}
.ddb-line{display:flex;white-space:pre-wrap;word-break:break-all;padding:0 6px}
.ddb-line-mark{width:12px;flex:none;opacity:.6;user-select:none}
.ddb-line-text{flex:1}
.ddb-line-\\+{background:rgba(46,160,67,.18)}
.ddb-line--{background:rgba(248,81,73,.18)}

/* syntax tokens */
.ddb-tok-k{color:#a626a4}
.ddb-tok-s{color:#50a14f}
.ddb-tok-c{color:#8a8f98;font-style:italic}
.ddb-tok-n{color:#986801}
.ddb-tok-o{color:#0184bc;opacity:.8}
body[data-ds-dark-theme] .ddb-tok-k{color:#c792ea}
body[data-ds-dark-theme] .ddb-tok-s{color:#7ec699}
body[data-ds-dark-theme] .ddb-tok-c{color:#676e95}
body[data-ds-dark-theme] .ddb-tok-n{color:#f78c6c}
body[data-ds-dark-theme] .ddb-tok-o{color:#89ddff}

/* wide overlay */
.ddb-overlay-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:190}
.ddb-overlay{position:fixed;top:0;right:0;bottom:0;width:min(78vw,1200px);z-index:200;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#ffffff);border-left:1px solid var(--dsw-alias-border-l2,#333);box-shadow:-12px 0 40px rgba(0,0,0,.5)}
.ddb-overlay-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-overlay-title{font-weight:600}
.ddb-overlay-session{font-size:11px;opacity:.5;font-family:ui-monospace,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-overlay-body{flex:1;overflow:hidden;display:flex;flex-direction:column;padding:10px 14px}
.ddb-worksplit{display:grid;grid-template-columns:minmax(240px,34%) 1fr;gap:12px;flex:1;min-height:0}
.ddb-worksplit-tree{min-width:0;overflow-y:auto;display:flex;flex-direction:column}
.ddb-worksplit-viewer{min-width:0;overflow-y:auto;display:flex;flex-direction:column}
.ddb-worksplit-tree .ddb-records{max-height:none;flex:1}
@media (max-width: 720px){
.ddb-worksplit{grid-template-columns:1fr}
.ddb-worksplit-tree{display:none}
}

/* sidebar footer entry */
.ddb-footbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;padding:0 8px;background:none;border:none;color:inherit;cursor:pointer;border-radius:8px;font-size:12px;flex:none}
.ddb-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.ddb-footbtn-wide{width:100%;justify-content:flex-start;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#333)}
.ddb-footbtn-icon{font-size:14px;line-height:1;display:inline-flex}
.ddb-footbtn-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
