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
.ddb-tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-tab{background:none;border:none;color:inherit;opacity:.6;cursor:pointer;padding:4px 8px;border-radius:6px;font-size:12px}
.ddb-tab:hover{opacity:.9}
.ddb-tab-active{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-body{flex:1;overflow-y:auto;padding:8px 12px 16px}
.ddb-note{opacity:.6;padding:12px 4px;line-height:1.5;font-size:12px}
.ddb-clean-note{border:1px dashed var(--dsw-alias-border-l2,#333);border-radius:8px;margin-bottom:8px;padding:8px 10px}
.ddb-error{color:var(--dsw-alias-state-error-primary,#d9534f)}
.ddb-empty{opacity:.6;padding:16px 12px;font-size:12px}
.ddb-group{margin-bottom:10px}
.ddb-group-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin:8px 0 4px}
.ddb-op{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;padding:6px 8px;cursor:pointer;color:inherit}
.ddb-op:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border-color:var(--dsw-alias-border-l2,#333)}
.ddb-op-head{display:flex;align-items:center;gap:8px}
.ddb-op-id{font-family:ui-monospace,monospace;font-size:11px;opacity:.85}
.ddb-op-time{font-size:10px;opacity:.45;margin-left:auto}
.ddb-op-kind{font-size:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border-radius:4px;padding:1px 5px}
.ddb-op-files{display:flex;flex-wrap:wrap;gap:4px}
.ddb-file{font-size:11px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border-radius:4px;padding:1px 6px;white-space:nowrap}
.ddb-file-del{opacity:.5;text-decoration:line-through}
.ddb-delta{opacity:.6;font-size:10px;margin-left:3px}
.ddb-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.ddb-back{background:none;border:none;color:inherit;cursor:pointer;opacity:.7;padding:2px 0;font-size:12px}
.ddb-back:hover{opacity:1}
.ddb-detail-id{font-family:ui-monospace,monospace}
.ddb-detail-meta{font-size:11px;opacity:.6}
.ddb-rewind-btn{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;margin-bottom:6px}
.ddb-rewind-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-rewind{font-size:11px;opacity:.7;margin-bottom:8px;word-break:break-all}
.ddb-opfile{border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;margin-bottom:8px;overflow:hidden}
.ddb-opfile-head{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04))}
.ddb-opfile-path{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}
.ddb-opfile-stats{font-size:10px;opacity:.6;white-space:nowrap}
.ddb-diff{max-height:280px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:11px;line-height:1.45}
.ddb-line{display:flex;white-space:pre-wrap;word-break:break-all;padding:0 6px}
.ddb-line-mark{width:12px;flex:none;opacity:.6;user-select:none}
.ddb-line-text{flex:1}
.ddb-line-\\+{background:rgba(46,160,67,.18)}
.ddb-line--{background:rgba(248,81,73,.18)}
.ddb-prompt{border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;margin-bottom:8px;padding:6px 8px}
.ddb-prompt-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin-bottom:3px}
.ddb-prompt-text{font-size:11px;line-height:1.5;opacity:.85;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.ddb-tree-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.ddb-tree-count{font-size:11px;opacity:.6}
.ddb-tree{display:flex;flex-direction:column;gap:1px;max-height:60vh;overflow-y:auto}
.ddb-tree-item{display:flex;justify-content:space-between;gap:8px;background:none;border:none;color:inherit;cursor:pointer;padding:3px 6px;border-radius:5px;font-size:11px;text-align:left;font-family:ui-monospace,monospace}
.ddb-tree-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-tree-item-path{word-break:break-all}
.ddb-tree-item-size{opacity:.4;font-size:10px;white-space:nowrap}
.ddb-viewer-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.ddb-viewer-path{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;flex:1;min-width:0}
.ddb-refreshing{font-size:10px;opacity:.5;font-style:italic;white-space:nowrap}
.ddb-filemeta{font-size:10px;opacity:.55;margin-bottom:6px}
.ddb-code{font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;overflow:hidden;margin-bottom:8px}
.ddb-cline{display:flex;white-space:pre-wrap;word-break:break-all}
.ddb-cline:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-cline-no{width:34px;flex:none;text-align:right;padding-right:8px;opacity:.4;user-select:none;border-right:1px solid var(--dsw-alias-border-l1,#2a2a2a);margin-right:8px}
.ddb-cline-text{flex:1;padding-right:8px}
.ddb-cline-hl{background:rgba(46,160,67,.16)}
.ddb-cline-hl:hover{background:rgba(46,160,67,.30);cursor:pointer}
.ddb-cline-note{box-shadow:inset 3px 0 0 #e5c07b}
.ddb-jump{background:rgba(229,192,123,.30)!important}
.ddb-tok-k{color:#a626a4}
.ddb-tok-s{color:#50a14f}
.ddb-tok-c{color:#8a8f98;font-style:italic}
.ddb-tok-n{color:#986801}
.ddb-tok-o{color:#0184bc;opacity:.8}
.ddb-filehistory{margin-top:4px}
.ddb-widen{display:block;width:100%;text-align:left;background:none;border:1px dashed var(--dsw-alias-border-l2,#333);color:inherit;border-radius:8px;padding:6px 8px;margin-bottom:8px;cursor:pointer;font-size:11px;opacity:.8}
.ddb-widen:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));opacity:1}
.ddb-fileop{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;font-size:11px;background:none;border:none;color:inherit;cursor:pointer;width:100%;text-align:left}
.ddb-fileop:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ddb-notes{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.ddb-note-item{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-left:3px solid #e5c07b;border-radius:6px;padding:5px 6px;font-size:11px}
.ddb-note-jump{background:none;border:none;color:inherit;cursor:pointer;opacity:.7;font-family:ui-monospace,monospace;font-size:10px;padding:0;white-space:nowrap}
.ddb-note-jump:hover{opacity:1;color:#b58900}
.ddb-note-body{flex:1;min-width:0}
.ddb-note-snippet{font-family:ui-monospace,monospace;font-size:10px;opacity:.55;white-space:pre-wrap;word-break:break-all;margin-bottom:2px}
.ddb-note-text{line-height:1.45;white-space:pre-wrap;word-break:break-word}
.ddb-note-del{background:none;border:none;color:inherit;cursor:pointer;opacity:.5;padding:0 2px;font-size:13px}
.ddb-note-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#d9534f)}
.ddb-note-form{position:fixed;z-index:300;width:240px;background:var(--dsw-alias-bg-overlay,#ffffff);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;padding:8px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.ddb-note-form-range{font-size:10px;opacity:.6;font-family:ui-monospace,monospace;margin-bottom:4px;word-break:break-all}
.ddb-note-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base,#ffffff);color:inherit;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:6px;padding:5px 6px;font-size:11px;resize:vertical;font-family:inherit}
.ddb-note-input:focus{outline:none;border-color:var(--dsw-alias-border-l3,#444)}
.ddb-note-form-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}
.ddb-note-save{background:var(--dsw-alias-accent,#4f8cff);color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px}
.ddb-note-save:disabled{opacity:.4;cursor:default}
.ddb-note-cancel{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px}
.ddb-overlay-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:190}
.ddb-overlay{position:fixed;top:0;right:0;bottom:0;width:min(72vw,1000px);z-index:200;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#ffffff);border-left:1px solid var(--dsw-alias-border-l2,#333);box-shadow:-12px 0 40px rgba(0,0,0,.5)}
.ddb-overlay-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-overlay-title{font-weight:600}
.ddb-overlay-session{font-size:11px;opacity:.5;font-family:ui-monospace,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddb-overlay-body{flex:1;overflow:hidden;display:flex;flex-direction:column;padding:10px 14px}
.ddb-worksplit{display:grid;grid-template-columns:minmax(240px,34%) 1fr;gap:12px;flex:1;min-height:0}
.ddb-worksplit-tree{min-width:0;overflow:hidden;display:flex;flex-direction:column}
.ddb-worksplit-viewer{min-width:0;overflow:hidden;display:flex;flex-direction:column}
.ddb-worksplit-viewer .ddb-viewer{display:flex;flex-direction:column;height:100%}
.ddb-worksplit-viewer .ddb-filecontent{flex:1;overflow-y:auto}
.ddb-worksplit-tree .ddb-tree{max-height:none;flex:1;overflow-y:auto}
.ddb-overlay-body .ddb-tree{max-height:none;flex:1;overflow-y:auto}
.ddb-footbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;padding:0 8px;background:none;border:none;color:inherit;cursor:pointer;border-radius:8px;font-size:12px;flex:none}
.ddb-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.ddb-footbtn-wide{width:100%;justify-content:flex-start;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#333)}
.ddb-footbtn-icon{font-size:14px;line-height:1;display:inline-flex}
.ddb-footbtn-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body[data-ds-dark-theme] .ddb-tok-k{color:#c792ea}
body[data-ds-dark-theme] .ddb-tok-s{color:#7ec699}
body[data-ds-dark-theme] .ddb-tok-c{color:#676e95}
body[data-ds-dark-theme] .ddb-tok-n{color:#f78c6c}
body[data-ds-dark-theme] .ddb-tok-o{color:#89ddff}
@media (max-width: 720px){
.ddb-worksplit{grid-template-columns:1fr}
.ddb-worksplit-tree{display:none}
}`;
