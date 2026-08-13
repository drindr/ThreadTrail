/**
 * DeltaDB-lite — browser half.
 *
 * A panel in the session-scoped `details` column: operation timeline between
 * commits, a realtime worktree review (file browser + syntax-highlighted
 * viewer with changed-line annotations and anchored notes on selected text),
 * and non-destructive rewind. An expand button opens a wide overlay
 * (`shell.overlay`) with the same worktree view.
 *
 * This file is a classic script bundle registered through the module loader
 * (the same shape the shipped client plugins use). Zero build step: the
 * factory's `require` resolves `react` and the dsh packages through the
 * loader's module table at runtime. Syntax highlighting and the shared
 * worktree store are self-contained inside the bundle.
 */
window.__ModuleLoader__.load({
  id: "deltadb-client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useSyncExternalStore = React.useSyncExternalStore;
    const createElement = React.createElement;
    const Fragment = React.Fragment;

    const NS = "deltadb";
    const en = {
      "panel.title": "DeltaDB",
      "panel.subtitle": "software is made between commits",
      "panel.refresh": "Refresh",
      "panel.expand": "Expand worktree",
      "panel.loading": "Loading…",
      "panel.error": "DeltaDB host not reachable ({error})",
      "panel.tab.timeline": "Timeline",
      "panel.tab.worktree": "Worktree",
    };
    const zh = en; // same key set; English text for now

    /** Fetch helper for the host routes. */
    function hostFetch(path, signal, options) {
      return fetch(path, { signal, headers: { accept: "application/json" }, ...options }).then((res) => {
        if (!res.ok) return res.json().then((b) => Promise.reject(new Error(b?.error || res.status)));
        return res.json();
      });
    }

    function fmtTime(ms) {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function fmtSize(bytes) {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    }

    // ── syntax highlighting (compact, dependency-free) ─────────────────────

    function escRe(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    const DQ = String.raw`"(?:[^"\\]|\\.)*"`;
    const SQ = String.raw`'(?:[^'\\]|\\.)*'`;
    const BT = String.raw`\`(?:[^\`\\]|\\.)*\``;
    const STR = `${DQ}|${SQ}|${BT}`;
    const NUM = String.raw`\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b`;
    const PUNCT = String.raw`[\[\]{}()\.,;:=<>+\-*/%&|^!~?]+`;

    const KW = {
      js: "abstract arguments async await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function get goto if implements import in instanceof int interface let long native new null of package private protected public return set short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield",
      ts: "abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get global implements import in infer instanceof interface is keyof let module namespace never new null number of override package private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield",
      python: "False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
      ruby: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
      go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
      rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
      java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while",
      c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
      cpp: "alignas alignof and and_eq asm auto bitand bitor bool break case catch char class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq",
      bash: "case do done elif else esac fi for function if in select then time until while coproc return local declare readonly export unset eval exec exit set shopt test true false",
      sql: "select from where insert into values update set delete create table alter drop index view join left right inner outer full cross on as and or not null primary key foreign references default unique check constraint group by order having limit offset union all distinct case when then else end exists between like in is",
      json: "true false null",
      yaml: "true false null yes no on off",
      toml: "true false",
      css: "!important",
    };

    /** @type {Record<string, {line?: string, block?: [string, string], str: string, kw: string}>} */
    const LANG_DEFS = {
      js: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.js },
      ts: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.ts },
      python: { line: String.raw`#[^\n]*`, str: STR, kw: KW.python },
      ruby: { line: String.raw`#[^\n]*`, str: STR, kw: KW.ruby },
      go: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.go },
      rust: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.rust },
      java: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.java },
      c: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.c },
      cpp: { line: String.raw`//[^\n]*`, block: ["/*", "*/"], str: STR, kw: KW.cpp },
      bash: { line: String.raw`#[^\n]*`, str: STR, kw: KW.bash },
      sql: { line: String.raw`--[^\n]*`, block: ["/*", "*/"], str: SQ, kw: KW.sql },
      json: { str: STR, kw: KW.json },
      yaml: { line: String.raw`#[^\n]*`, str: STR, kw: KW.yaml },
      toml: { line: String.raw`#[^\n]*`, str: STR, kw: KW.toml },
      css: { block: ["/*", "*/"], str: STR, kw: KW.css },
      html: { block: ["<!--", "-->"], str: DQ, kw: "" },
      text: { str: "", kw: "" },
    };

    const EXT_LANG = {
      js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", mts: "ts",
      py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
      c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
      sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
      json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
      css: "css", scss: "css", html: "html", htm: "html", vue: "html", svelte: "html", xml: "html",
      txt: "text", gitignore: "text", env: "text", md: "text",
    };

    function detectLang(path) {
      const base = String(path || "").split("/").pop() || "";
      const dot = base.lastIndexOf(".");
      if (dot > 0) {
        const l = EXT_LANG[base.slice(dot + 1).toLowerCase()];
        if (l) return l;
      }
      if (base === "Dockerfile" || base === "Makefile" || base === "Rakefile") return "bash";
      return "text";
    }

    /** Build a compiled tokenizer config for a language. */
    function buildConfig(lang) {
      const def = LANG_DEFS[lang] || LANG_DEFS.text;
      const kw = def.kw ? `(?:${def.kw.split(/\s+/).filter(Boolean).map(escRe).join("|")})` : "";
      const parts = [];
      if (def.str) parts.push(`(${def.str})`); // 1 string
      if (def.line) parts.push(`(${def.line})`); // 2 line comment
      if (kw) parts.push(`(\\b${kw}\\b)`); // 3 keyword
      parts.push(`(${NUM})`); // 4 number
      parts.push(`(${PUNCT})`); // 5 punct
      return {
        re: new RegExp(parts.join("|"), "g"),
        block: def.block || null,
      };
    }

    const compiled = new Map();
    function configFor(lang) {
      let c = compiled.get(lang);
      if (!c) {
        c = buildConfig(lang);
        compiled.set(lang, c);
      }
      return c;
    }

    /** Tokenize one line into {t, text} tokens: p plain, s string, c comment, k keyword, n number, o operator. */
    function tokenizeLine(text, cfg) {
      const out = [];
      if (!text) return out;
      const re = cfg.re;
      re.lastIndex = 0;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) out.push({ t: "p", text: text.slice(last, m.index) });
        const cls = m[1] !== undefined ? "s" : m[2] !== undefined ? "c" : m[3] !== undefined ? "k" : m[4] !== undefined ? "n" : "o";
        out.push({ t: cls, text: m[0] });
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push({ t: "p", text: text.slice(last) });
      return out;
    }

    /**
     * Per-file highlighter with block-comment state, so multi-line comments
     * stay colored across lines.
     */
    function createHighlighter(lang) {
      const cfg = configFor(lang);
      let inBlock = false;
      return function highlightLine(line) {
        if (line === "") return [{ t: "p", text: "" }];
        if (!cfg.block) return tokenizeLine(line, cfg);
        const [bs, be] = cfg.block;
        let rest = line;
        const parts = [];
        if (inBlock) {
          const i = rest.indexOf(be);
          if (i === -1) return [{ t: "c", text: rest }];
          parts.push({ t: "c", text: rest.slice(0, i + be.length) });
          rest = rest.slice(i + be.length);
          inBlock = false;
        }
        const s = rest.indexOf(bs);
        if (s === -1) {
          parts.push(...tokenizeLine(rest, cfg));
          return parts;
        }
        parts.push(...tokenizeLine(rest.slice(0, s), cfg));
        const e = rest.indexOf(be, s + bs.length);
        if (e === -1) {
          parts.push({ t: "c", text: rest.slice(s) });
          inBlock = true;
          return parts;
        }
        parts.push({ t: "c", text: rest.slice(s, e + be.length) });
        parts.push(...tokenizeLine(rest.slice(e + be.length), cfg));
        return parts;
      };
    }

    /** Render one line's tokens as spans (or a plain string when lang is text). */
    function renderTokens(tokens, keyPrefix) {
      return tokens.map((tok, i) =>
        createElement(
          "span",
          { key: `${keyPrefix}-${i}`, className: tok.t === "p" ? undefined : `ddb-tok-${tok.t}` },
          tok.text,
        ),
      );
    }

    // ── shared worktree store (details panel + overlay use one state) ──────

    const worktreeStore = (() => {
      let state = {
        sessionId: null,
        tree: null,
        treeError: null,
        openPath: null,
        fileData: null,
        fileError: null,
        fileLoading: false,
        overlayOpen: false,
        overlayDismissed: false,
        selection: null, // {startLine, endLine, snippet, x, y}
        noteDraft: "",
        saving: false,
      };
      const listeners = new Set();
      let fetchSeq = 0;
      return {
        get: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set(patch) {
          state = { ...state, ...patch };
          listeners.forEach((l) => l());
        },
        reset(sessionId) {
          fetchSeq++;
          this.set({ sessionId, tree: null, treeError: null, openPath: null, fileData: null, fileError: null, selection: null, noteDraft: "", saving: false, overlayOpen: false, overlayDismissed: false });
          this.fetchTree(sessionId);
        },
        async fetchTree(sessionId) {
          const seq = ++fetchSeq;
          this.set({ treeError: null });
          try {
            const t = await hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/tree.json`);
            if (seq !== fetchSeq) return;
            this.set({ tree: t, treeError: null });
          } catch (e) {
            if (seq === fetchSeq) this.set({ treeError: e.message });
          }
        },
        async openFile(sessionId, rel) {
          const seq = ++fetchSeq;
          this.set({ openPath: rel, fileData: null, fileError: null, fileLoading: true, selection: null, noteDraft: "" });
          try {
            const d = await hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/file.json?path=${encodeURIComponent(rel)}`);
            if (seq !== fetchSeq) return;
            this.set({ fileData: d, fileError: null, fileLoading: false });
          } catch (e) {
            if (seq === fetchSeq) this.set({ fileError: e.message, fileLoading: false });
          }
        },
        closeFile() {
          this.set({ openPath: null, fileData: null, fileError: null, selection: null, noteDraft: "" });
        },
        /** Realtime: re-read the open file when the agent works. */
        refreshOpen(sessionId) {
          const s = this.get();
          if (s.openPath) this.openFile(sessionId, s.openPath);
        },
        openOverlay(sessionId) {
          this.set({ overlayOpen: true, sessionId, overlayDismissed: false });
        },
        closeOverlay() {
          this.set({ overlayOpen: false, selection: null, noteDraft: "", overlayDismissed: true });
        },
        async addNote(sessionId) {
          const s = this.get();
          if (!s.selection || !s.noteDraft.trim() || s.saving) return;
          this.set({ saving: true });
          try {
            await hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/notes`, undefined, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                path: s.openPath,
                startLine: s.selection.startLine,
                endLine: s.selection.endLine,
                snippet: s.selection.snippet,
                note: s.noteDraft,
              }),
            });
            this.set({ saving: false, selection: null, noteDraft: "" });
            if (s.openPath) this.openFile(sessionId, s.openPath);
          } catch (e) {
            this.set({ saving: false, fileError: `note failed: ${e.message}` });
          }
        },
        async deleteNote(sessionId, id) {
          const s = this.get();
          try {
            await hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(id)}`, undefined, { method: "DELETE" });
            if (s.openPath) this.openFile(sessionId, s.openPath);
          } catch (e) {
            this.set({ fileError: `delete failed: ${e.message}` });
          }
        },
      };
    })();

    function useWorktree() {
      // Third arg (getServerSnapshot) keeps react-dom/server renders happy;
      // the browser ignores it (client-only rendering).
      return useSyncExternalStore(worktreeStore.subscribe, worktreeStore.get, worktreeStore.get);
    }

    // ── components ─────────────────────────────────────────────────────────

    function DeltaPanel(props) {
      const sessionId = props.sessionId;
      const useSession = props.useSession;
      const useSessions = props.useSessions;
      const windowLen = useSession ? useSession((s) => (s && s.nodes ? s.nodes.length : 0)) : 0;
      const _sessions = useSessions ? useSessions((s) => s) : null;
      const wt = useWorktree();

      const [digest, setDigest] = useState(null);
      const [opRecord, setOpRecord] = useState(null);
      const [error, setError] = useState(null);
      const [rewindInfo, setRewindInfo] = useState(null);
      const [tab, setTab] = useState("timeline");

      // The details column is narrow (ui-layout caps it at 520px), so entering
      // the worktree tab auto-opens the wide overlay review — unless the user
      // dismissed it for this session (they can reopen via ⛶ or the banner).
      const selectTab = (next) => {
        setTab(next);
        if (next === "worktree" && !wt.overlayOpen && !wt.overlayDismissed) {
          worktreeStore.openOverlay(sessionId);
        }
      };

      const fetchDigest = useCallback(
        async (signal) => {
          if (!sessionId) return;
          try {
            const d = await hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/digest.json`, signal);
            setDigest(d);
            setError(null);
          } catch (e) {
            if (e.name !== "AbortError") setError(e.message);
          }
        },
        [sessionId],
      );

      // Refetch digest (and the open worktree file) on session/window change:
      // that is the "realtime worktree review" — every conversation change
      // re-reads the current file while the agent works.
      useEffect(() => {
        if (!sessionId) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => {
          fetchDigest(ctrl.signal);
          worktreeStore.refreshOpen(sessionId);
        }, windowLen === 0 ? 0 : 400);
        return () => {
          clearTimeout(timer);
          ctrl.abort();
        };
      }, [sessionId, windowLen, fetchDigest]);

      // Reset per-session view state.
      useEffect(() => {
        setOpRecord(null);
        setRewindInfo(null);
        setError(null);
        worktreeStore.reset(sessionId);
      }, [sessionId]);

      // Auto-open the details column when a session with conversation is
      // selected so the panel is discoverable.
      useEffect(() => {
        if (!sessionId || windowLen === 0) return;
        const t = setTimeout(() => {
          try {
            props.openDetails?.();
          } catch {
            /* layout panel actions not wired yet — fine */
          }
        }, 150);
        return () => clearTimeout(t);
      }, [sessionId, windowLen, props.openDetails]);

      if (!sessionId) {
        return createElement("div", { className: "ddb-empty" }, "Open a session to see its edit history.");
      }

      const ops = digest ? digest.ops : [];

      const openOp = (opId) => {
        setRewindInfo(null);
        hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/op/${encodeURIComponent(opId)}.json`)
          .then(setOpRecord)
          .catch((e) => setError(e.message));
      };

      const doRewind = (opId) => {
        setRewindInfo({ pending: opId });
        hostFetch(`/deltadb/${encodeURIComponent(sessionId)}/rewind/${encodeURIComponent(opId)}.json`)
          .then((r) => setRewindInfo({ ok: true, target: r.target, count: r.files.length }))
          .catch((e) => setRewindInfo({ err: e.message }));
      };

      const grouped = [];
      const manual = [];
      for (const op of ops) {
        (op.turn == null ? manual : grouped).push(op);
      }
      grouped.reverse(); // newest turn first
      const byTurn = new Map();
      for (const op of grouped) {
        const list = byTurn.get(op.turn) || [];
        list.push(op);
        byTurn.set(op.turn, list);
      }

      const header = createElement(
        "div",
        { className: "ddb-header" },
        createElement(
          "div",
          { className: "ddb-title" },
          createElement("span", { className: "ddb-title-main" }, "DeltaDB"),
          createElement("span", { className: "ddb-title-sub" }, "software is made between commits"),
        ),
        createElement(
          "div",
          { className: "ddb-header-actions" },
          createElement(
            "button",
            { type: "button", className: "ddb-iconbtn", title: "Expand worktree", onClick: () => worktreeStore.openOverlay(sessionId) },
            "⛶",
          ),
          createElement(
            "button",
            { type: "button", className: "ddb-iconbtn", onClick: () => fetchDigest() },
            "↻",
          ),
        ),
      );

      let body;
      if (error && !digest) {
        body = createElement("div", { className: "ddb-note ddb-error" }, `DeltaDB host: ${error}`);
      } else if (!digest) {
        body = createElement("div", { className: "ddb-note" }, "Loading…");
      } else if (opRecord) {
        body = renderOpDetail(opRecord, rewindInfo, doRewind, (fn) => {
          setOpRecord(null);
          fn && fn();
        });
      } else if (tab === "worktree") {
        body = createElement(WorktreeView, { sessionId, onOpenOp: openOp });
      } else {
        body = renderTimeline(byTurn, manual, ops, openOp);
      }

      const tabs = createElement(
        "div",
        { className: "ddb-tabs" },
        createElement(
          "button",
          { type: "button", className: tab === "timeline" ? "ddb-tab ddb-tab-active" : "ddb-tab", onClick: () => selectTab("timeline") },
          "Timeline",
        ),
        createElement(
          "button",
          { type: "button", className: tab === "worktree" ? "ddb-tab ddb-tab-active" : "ddb-tab", onClick: () => selectTab("worktree") },
          "Worktree",
        ),
      );

      return createElement(
        "div",
        { className: "ddb-root" },
        header,
        tabs,
        createElement("div", { className: "ddb-body" }, body),
      );
    }

    function renderTimeline(byTurn, manual, ops, openOp) {
      const children = [];
      const turns = [...byTurn.keys()].sort((a, b) => b - a);
      for (const turn of turns) {
        const list = byTurn.get(turn);
        children.push(
          createElement("div", { key: `t${turn}`, className: "ddb-group" },
            createElement("div", { className: "ddb-group-label" }, `turn ${turn}`),
            ...list.map((op) => opRow(op, openOp)),
          ),
        );
      }
      if (manual.length) {
        children.push(
          createElement("div", { key: "manual", className: "ddb-group" },
            createElement("div", { className: "ddb-group-label" }, "manual edits"),
            ...manual.map((op) => opRow(op, openOp)),
          ),
        );
      }
      return createElement(Fragment, null, ...children);
    }

    function opRow(op, openOp) {
      const files = op.files.map((f, i) =>
        createElement(
          "span",
          { key: i, className: "ddb-file" + (f.deleted ? " ddb-file-del" : "") },
          f.path,
          !f.deleted && (f.added || f.removed)
            ? createElement("span", { className: "ddb-delta" }, `+${f.added}/-${f.removed}`)
            : null,
        ),
      );
      return createElement(
        "button",
        { key: op.id, type: "button", className: "ddb-op", onClick: () => openOp(op.id) },
        createElement("div", { className: "ddb-op-head" },
          createElement("span", { className: "ddb-op-id" }, op.id),
          createElement("span", { className: "ddb-op-time" }, fmtTime(op.time)),
          createElement("span", { className: "ddb-op-kind" }, op.kind === "manual" ? "manual" : `turn ${op.turn}`),
        ),
        createElement("div", { className: "ddb-op-files" }, files),
      );
    }

    /** Op detail: diff lines are syntax-highlighted by each file's language. */
    function renderOpDetail(rec, rewindInfo, doRewind, close) {
      const fileRows = rec.files.map((f, i) => {
        const lang = detectLang(f.path);
        const hl = createHighlighter(lang);
        const head = createElement(
          "div",
          { className: "ddb-opfile-head" },
          createElement("span", { className: "ddb-opfile-path" }, f.path),
          createElement("span", { className: "ddb-opfile-stats" },
            f.deleted ? "deleted" : `+${f.added}/-${f.removed}`),
        );
        let diffEl = null;
        if (!f.deleted && Array.isArray(f.diff)) {
          const lines = f.diff.map((l, j) =>
            createElement("div", { key: j, className: "ddb-line ddb-line-" + l.t },
              createElement("span", { className: "ddb-line-mark" }, l.t === " " ? " " : l.t),
              createElement("span", { className: "ddb-line-text" }, ...renderTokens(hl(l.text), `d${i}-${j}`)),
            ),
          );
          diffEl = createElement("div", { className: "ddb-diff" }, ...lines);
        }
        return createElement("div", { key: i, className: "ddb-opfile" }, head, diffEl);
      });

      const rewindEl = rewindInfo
        ? createElement(
            "div",
            { className: "ddb-rewind" },
            rewindInfo.pending
              ? "Rewinding…"
              : rewindInfo.err
                ? `Rewind failed: ${rewindInfo.err}`
                : `Materialized into ${rewindInfo.target} (${rewindInfo.count} files)`,
          )
        : null;

      return createElement(
        "div",
        { className: "ddb-detail" },
        createElement("div", { className: "ddb-detail-head" },
          createElement("button", { type: "button", className: "ddb-back", onClick: () => close() }, "← back"),
          createElement("span", { className: "ddb-detail-id" }, rec.id),
          createElement("span", { className: "ddb-detail-meta" },
            rec.kind === "manual" ? "manual edit" : `turn ${rec.turn}`,
            rec.userMessageSeq != null ? ` · prompt seq ${rec.userMessageSeq}` : "",
            rec.assistantSeqs && rec.assistantSeqs.length ? ` · assistant ${rec.assistantSeqs.join(",")}` : "",
          ),
        ),
        rec.prompt
          ? createElement("div", { className: "ddb-prompt" },
              createElement("div", { className: "ddb-prompt-label" }, "prompt that drove this change"),
              createElement("div", { className: "ddb-prompt-text" }, rec.prompt),
            )
          : null,
        createElement(
          "button",
          { type: "button", className: "ddb-rewind-btn", onClick: () => doRewind(rec.id) },
          "rewind workspace to this point (non-destructive)",
        ),
        rewindEl,
        createElement("div", { className: "ddb-detail-files" }, ...fileRows),
      );
    }

    /**
     * The worktree view (file tree + viewer + notes). Shared by the details
     * panel and the expanded overlay through the worktree store.
     */
    function WorktreeView({ sessionId, onOpenOp }) {
      const wt = useWorktree();

      useEffect(() => {
        if (sessionId && wt.tree === null && !wt.treeError) worktreeStore.fetchTree(sessionId);
      }, [sessionId, wt.tree, wt.treeError]);

      const banner = !wt.overlayOpen
        ? createElement(
            "button",
            { type: "button", className: "ddb-widen", onClick: () => worktreeStore.openOverlay(sessionId) },
            "⛶ Open wide review (this column is capped at 520px)",
          )
        : null;

      if (!wt.openPath) {
        return createElement(Fragment, null, banner, renderTreeList(wt, (rel) => worktreeStore.openFile(sessionId, rel)));
      }
      return createElement(Fragment, null, banner, renderViewer(wt, sessionId, onOpenOp));
    }

    function renderTreeList(wt, openFile) {
      const head = createElement(
        "div",
        { className: "ddb-tree-head" },
        createElement("span", { className: "ddb-tree-count" },
          wt.tree ? `${wt.tree.files.length} files` : "…"),
        createElement("button", { type: "button", className: "ddb-iconbtn", onClick: () => wt.sessionId && worktreeStore.fetchTree(wt.sessionId) }, "↻"),
      );
      if (wt.treeError) {
        return createElement(Fragment, null, head, createElement("div", { className: "ddb-note ddb-error" }, `Worktree: ${wt.treeError}`));
      }
      if (!wt.tree) {
        return createElement(Fragment, null, head, createElement("div", { className: "ddb-note" }, "Loading worktree…"));
      }
      if (!wt.tree.files.length) {
        return createElement(Fragment, null, head, createElement("div", { className: "ddb-note" }, "Workspace is empty."));
      }
      const items = wt.tree.files.map((f) =>
        createElement(
          "button",
          { key: f.path, type: "button", className: "ddb-tree-item", onClick: () => openFile(f.path), title: f.path },
          createElement("span", { className: "ddb-tree-item-path" }, f.path),
          createElement("span", { className: "ddb-tree-item-size" }, fmtSize(f.size)),
        ),
      );
      return createElement(
        Fragment,
        null,
        head,
        wt.tree.truncated ? createElement("div", { className: "ddb-note" }, `showing first ${wt.tree.files.length} files`) : null,
        createElement("div", { className: "ddb-tree" }, ...items),
      );
    }

    function renderViewer(wt, sessionId, onOpenOp) {
      const head = createElement(
        "div",
        { className: "ddb-viewer-head" },
        createElement("button", { type: "button", className: "ddb-back", onClick: () => worktreeStore.closeFile() }, "← files"),
        createElement("span", { className: "ddb-viewer-path", title: wt.openPath }, wt.openPath),
        createElement("button", { type: "button", className: "ddb-iconbtn", onClick: () => worktreeStore.openFile(sessionId, wt.openPath) }, "↻"),
      );

      let content;
      if (wt.fileError) {
        content = createElement("div", { className: "ddb-note ddb-error" }, wt.fileError);
      } else if (!wt.fileData) {
        content = createElement("div", { className: "ddb-note" }, wt.fileLoading ? "Loading file…" : "Open a file to review it.");
      } else {
        content = createElement(FileContent, { wt, sessionId, onOpenOp });
      }

      return createElement(
        "div",
        { className: "ddb-viewer" },
        head,
        content,
      );
    }

    /** The file content: highlighted lines, change annotations, notes. */
    function FileContent({ wt, sessionId, onOpenOp }) {
      const lang = detectLang(wt.openPath);
      const hl = useMemo(() => createHighlighter(lang), [lang]);
      const codeRef = useRef(null);
      const [noteBox, setNoteBox] = useState(null); // {startLine, endLine, snippet, x, y}
      const { fileData } = wt;

      const ops = fileData.ops || [];
      const notes = fileData.notes || [];

      // Lines changed by the latest op (accurate for current content only).
      const changed = useMemo(() => {
        const set = new Set();
        let latest = null;
        for (const entry of ops) {
          const f = entry.files && entry.files[0];
          if (f && !f.deleted && f.newRanges && f.newRanges.length) latest = entry;
        }
        if (latest) {
          for (const r of latest.files[0].newRanges) for (let i = r.start; i <= r.end; i++) set.add(i);
        }
        return { set, latest };
      }, [ops]);

      const noteLines = useMemo(() => {
        const m = new Map();
        for (const n of notes) {
          for (let i = n.startLine; i <= n.endLine; i++) {
            if (!m.has(i)) m.set(i, n);
          }
        }
        return m;
      }, [notes]);

      const raw = fileData.content.split("\n");
      if (raw.length && raw[raw.length - 1] === "") raw.pop();
      const MAX_SHOWN = 2000;
      const shown = raw.slice(0, MAX_SHOWN);

      const rows = shown.map((text, idx) => {
        const lineNo = idx + 1;
        const hlLine = changed.set.has(lineNo);
        const note = noteLines.get(lineNo);
        return createElement(
          "div",
          {
            key: lineNo,
            "data-line": lineNo,
            className: "ddb-cline" + (hlLine ? " ddb-cline-hl" : "") + (note ? " ddb-cline-note" : ""),
            title: hlLine && changed.latest
              ? `changed in ${changed.latest.opId} (turn ${changed.latest.turn ?? "manual"}) — click for the conversation`
              : note
                ? `${note.id}: ${note.note}`
                : undefined,
            onClick: hlLine && changed.latest ? () => onOpenOp(changed.latest.opId) : undefined,
          },
          createElement("span", { className: "ddb-cline-no" }, lineNo),
          createElement("span", { className: "ddb-cline-text" }, ...renderTokens(hl(text), `l${lineNo}`)),
        );
      });

      // Selection → anchored note (only for selections inside the code block).
      function onMouseUp() {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          setNoteBox(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const startEl = closestLine(range.startContainer);
        const endEl = closestLine(range.endContainer);
        const codeEl = codeRef.current;
        if (!startEl || !endEl || !codeEl || !codeEl.contains(startEl) || !codeEl.contains(endEl)) {
          setNoteBox(null);
          return;
        }
        const startLine = Number(startEl.getAttribute("data-line"));
        const endLine = Number(endEl.getAttribute("data-line"));
        const snippet = sel.toString().replace(/\s+/g, " ").slice(0, 500);
        const rect = range.getBoundingClientRect();
        worktreeStore.set({ selection: { startLine, endLine, snippet, x: rect.right, y: rect.bottom }, noteDraft: "" });
        setNoteBox({ startLine, endLine, snippet, x: rect.right, y: rect.bottom });
      }

      function closestLine(node) {
        let el = node && node.nodeType === 3 ? node.parentElement : node;
        while (el && el !== document.body) {
          if (el.classList && el.classList.contains("ddb-cline")) return el;
          el = el.parentElement;
        }
        return null;
      }

      const meta = [];
      if (fileData.truncated) meta.push("(truncated)");
      if (changed.latest) meta.push(`highlighted: lines changed by ${changed.latest.opId}`);

      // per-file op history (code -> conversation)
      const opRows = ops.map((entry) => {
        const f = entry.files && entry.files[0];
        const stats = f && f.deleted ? "deleted" : f ? `+${f.added}/-${f.removed}` : "";
        return createElement(
          "button",
          { key: entry.opId, type: "button", className: "ddb-fileop", onClick: () => onOpenOp(entry.opId) },
          createElement("span", { className: "ddb-op-id" }, entry.opId),
          createElement("span", { className: "ddb-op-kind" }, entry.kind === "manual" ? "manual" : `turn ${entry.turn}`),
          createElement("span", { className: "ddb-delta" }, stats),
          createElement("span", { className: "ddb-op-time" }, fmtTime(entry.time)),
        );
      });

      // anchored notes list
      const noteItems = notes.map((n) =>
        createElement(
          "div",
          { key: n.id, className: "ddb-note-item" },
          createElement(
            "button",
            { type: "button", className: "ddb-note-jump", title: `L${n.startLine}-${n.endLine}`,
              onClick: () => jumpToLine(n.startLine) },
            `L${n.startLine}${n.endLine !== n.startLine ? `-${n.endLine}` : ""}`,
          ),
          createElement("div", { className: "ddb-note-body" },
            n.snippet ? createElement("div", { className: "ddb-note-snippet" }, n.snippet) : null,
            createElement("div", { className: "ddb-note-text" }, n.note),
          ),
          createElement(
            "button",
            { type: "button", className: "ddb-note-del", title: "delete note", onClick: () => worktreeStore.deleteNote(sessionId, n.id) },
            "×",
          ),
        ),
      );

      function jumpToLine(line) {
        const el = codeRef.current && codeRef.current.querySelector(`[data-line="${line}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.remove("ddb-jump");
          void el.offsetWidth;
          el.classList.add("ddb-jump");
        }
      }

      return createElement(
        "div",
        { className: "ddb-filecontent" },
        meta.length ? createElement("div", { className: "ddb-filemeta" }, meta.join(" · ")) : null,
        createElement(
          "div",
          { className: "ddb-code", ref: codeRef, onMouseUp },
          ...rows,
        ),
        noteBox
          ? createElement(NoteForm, {
              box: noteBox,
              onCancel: () => setNoteBox(null),
              onSave: () => worktreeStore.addNote(sessionId),
            })
          : null,
        raw.length > MAX_SHOWN ? createElement("div", { className: "ddb-note" }, `showing first ${MAX_SHOWN} of ${raw.length} lines`) : null,
        noteItems.length
          ? createElement("div", { className: "ddb-notes" },
              createElement("div", { className: "ddb-group-label" }, `notes (${noteItems.length})`),
              ...noteItems,
            )
          : null,
        createElement("div", { className: "ddb-filehistory" },
          createElement("div", { className: "ddb-group-label" }, "edits to this file"),
          opRows.length
            ? createElement("div", { className: "ddb-filefocus-ops" }, ...opRows)
            : createElement("div", { className: "ddb-note" }, "No captured edits yet."),
        ),
      );
    }

    /** Floating note composer anchored to the selection. */
    function NoteForm({ box, onCancel, onSave }) {
      const wt = useWorktree();
      const [text, setText] = useState(wt.noteDraft);
      useEffect(() => {
        worktreeStore.set({ noteDraft: text });
      }, [text]);
      return createElement(
        "div",
        { className: "ddb-note-form", style: { left: Math.max(8, box.x - 220), top: box.y + 8 } },
        createElement("div", { className: "ddb-note-form-range" }, `L${box.startLine}${box.endLine !== box.startLine ? `-${box.endLine}` : ""} · ${box.snippet.length > 60 ? box.snippet.slice(0, 60) + "…" : box.snippet}`),
        createElement("textarea", {
          className: "ddb-note-input",
          rows: 2,
          placeholder: "Write a note…",
          value: text,
          autoFocus: true,
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSave();
            if (e.key === "Escape") onCancel();
          },
        }),
        createElement("div", { className: "ddb-note-form-actions" },
          createElement("button", { type: "button", className: "ddb-note-save", disabled: wt.saving || !text.trim(), onClick: onSave }, wt.saving ? "saving…" : "save"),
          createElement("button", { type: "button", className: "ddb-note-cancel", onClick: onCancel }, "cancel"),
        ),
      );
    }

    /** Wide overlay (shell.overlay) with the same worktree view. */
    function WorktreeOverlay(props) {
      const wt = useWorktree();
      const useSessions = props.useSessions;
      const currentId = useSessions
        ? useSessions((s) => (s.current !== undefined && s.byId[s.current]?.blank === false ? s.current : undefined))
        : undefined;
      const sessionId = wt.sessionId || currentId;
      if (!wt.overlayOpen || !sessionId) return null;

      return createElement(
        Fragment,
        null,
        createElement("div", { className: "ddb-overlay-backdrop", onClick: () => worktreeStore.closeOverlay() }),
        createElement(
          "div",
          { className: "ddb-overlay" },
          createElement("div", { className: "ddb-overlay-head" },
            createElement("span", { className: "ddb-overlay-title" }, "DeltaDB — worktree review"),
            createElement("span", { className: "ddb-overlay-session" }, sessionId),
            createElement("button", { type: "button", className: "ddb-iconbtn", title: "close", onClick: () => worktreeStore.closeOverlay() }, "✕"),
          ),
          createElement(
            "div",
            { className: "ddb-overlay-body" },
            createElement("div", { className: "ddb-worksplit" },
              createElement("div", { className: "ddb-worksplit-tree" },
                renderTreeList(wt, (rel) => worktreeStore.openFile(sessionId, rel)),
              ),
              createElement("div", { className: "ddb-worksplit-viewer" },
                wt.openPath
                  ? renderViewer(wt, sessionId, () => {})
                  : createElement("div", { className: "ddb-note" }, "Select a file on the left to review it."),
              ),
            ),
          ),
        ),
      );
    }

    const inject = ["slots", "locale", "layout"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "deltadb-client: dictionaries");
      ctx.effect(() => {
        // Owned stylesheet (the loader removes <style data-plugin> on reload).
        const style = document.createElement("style");
        style.setAttribute("data-plugin", "deltadb-client");
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "deltadb-client: styles");

      // The `details` column is declared session-scoped by ui-layout; this
      // panel is its occupant. openDetails comes from the layout service so
      // the panel can open the column when a session is selected.
      ctx.slots.inject("details", () =>
        ctx.slots.register(
          {
            name: "details",
            locale: NS,
            // shadows ui-conversation's details registration (priority 0);
            // lowest priority renders in a single slot. Bump back if both must coexist.
            priority: -1,
            inject: () => ({ openDetails: () => ctx.layout.openDetails() }),
          },
          DeltaPanel,
        ),
      );

      // The wide overlay (additive list slot; floats over the whole app).
      ctx.slots.register(
        {
          name: "shell.overlay",
          id: "deltadb-overlay",
          locale: NS,
          inject: () => ({}),
        },
        WorktreeOverlay,
      );
    }

    exports.DeltaPanel = DeltaPanel;
    exports.WorktreeOverlay = WorktreeOverlay;
    exports.detectLang = detectLang;
    exports.createHighlighter = createHighlighter;
    exports.apply = apply;
    exports.inject = inject;

    const CSS = `
.ddb-root{display:flex;flex-direction:column;height:100%;min-width:0;font-size:12px;color:var(--dsw-alias-text-primary,#e2e2e2)}
.ddb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-title{display:flex;flex-direction:column;gap:2px}
.ddb-title-main{font-weight:600;letter-spacing:.02em}
.ddb-title-sub{font-size:10px;opacity:.55}
.ddb-header-actions{display:flex;gap:4px}
.ddb-iconbtn{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1}
.ddb-iconbtn:hover{background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a2a)}
.ddb-tab{background:none;border:none;color:inherit;opacity:.6;cursor:pointer;padding:4px 8px;border-radius:6px;font-size:12px}
.ddb-tab:hover{opacity:.9}
.ddb-tab-active{opacity:1;background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-body{flex:1;overflow-y:auto;padding:8px 12px 16px}
.ddb-note{opacity:.6;padding:12px 4px;line-height:1.5;font-size:12px}
.ddb-error{color:#ff8b8b}
.ddb-empty{opacity:.6;padding:16px 12px;font-size:12px}
.ddb-group{margin-bottom:10px}
.ddb-group-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin:8px 0 4px}
.ddb-op{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;padding:6px 8px;cursor:pointer;color:inherit}
.ddb-op:hover{background:var(--dsw-alias-fill-hover,#ffffff14);border-color:var(--dsw-alias-border-l2,#333)}
.ddb-op-head{display:flex;align-items:center;gap:8px}
.ddb-op-id{font-family:ui-monospace,monospace;font-size:11px;opacity:.85}
.ddb-op-time{font-size:10px;opacity:.45;margin-left:auto}
.ddb-op-kind{font-size:10px;background:var(--dsw-alias-fill-hover,#ffffff14);border-radius:4px;padding:1px 5px}
.ddb-op-files{display:flex;flex-wrap:wrap;gap:4px}
.ddb-file{font-size:11px;background:var(--dsw-alias-fill-hover,#ffffff14);border-radius:4px;padding:1px 6px;white-space:nowrap}
.ddb-file-del{opacity:.5;text-decoration:line-through}
.ddb-delta{opacity:.6;font-size:10px;margin-left:3px}
.ddb-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.ddb-back{background:none;border:none;color:inherit;cursor:pointer;opacity:.7;padding:2px 0;font-size:12px}
.ddb-back:hover{opacity:1}
.ddb-detail-id{font-family:ui-monospace,monospace}
.ddb-detail-meta{font-size:11px;opacity:.6}
.ddb-rewind-btn{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;margin-bottom:6px}
.ddb-rewind-btn:hover{background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-rewind{font-size:11px;opacity:.7;margin-bottom:8px;word-break:break-all}
.ddb-opfile{border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;margin-bottom:8px;overflow:hidden}
.ddb-opfile-head{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;background:var(--dsw-alias-fill-hover,#0ffffff)}
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
.ddb-tree-item:hover{background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-tree-item-path{word-break:break-all}
.ddb-tree-item-size{opacity:.4;font-size:10px;white-space:nowrap}
.ddb-viewer-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.ddb-viewer-path{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;flex:1;min-width:0}
.ddb-filemeta{font-size:10px;opacity:.55;margin-bottom:6px}
.ddb-code{font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-radius:8px;overflow:hidden;margin-bottom:8px}
.ddb-cline{display:flex;white-space:pre-wrap;word-break:break-all}
.ddb-cline:hover{background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-cline-no{width:34px;flex:none;text-align:right;padding-right:8px;opacity:.4;user-select:none;border-right:1px solid var(--dsw-alias-border-l1,#2a2a2a);margin-right:8px}
.ddb-cline-text{flex:1;padding-right:8px}
.ddb-cline-hl{background:rgba(46,160,67,.16)}
.ddb-cline-hl:hover{background:rgba(46,160,67,.30);cursor:pointer}
.ddb-cline-note{box-shadow:inset 3px 0 0 #e5c07b}
.ddb-jump{background:rgba(229,192,123,.30)!important}
.ddb-tok-k{color:#c792ea}
.ddb-tok-s{color:#7ec699}
.ddb-tok-c{color:#676e95;font-style:italic}
.ddb-tok-n{color:#f78c6c}
.ddb-tok-o{color:#89ddff;opacity:.8}
.ddb-filehistory{margin-top:4px}
.ddb-widen{display:block;width:100%;text-align:left;background:none;border:1px dashed var(--dsw-alias-border-l2,#333);color:inherit;border-radius:8px;padding:6px 8px;margin-bottom:8px;cursor:pointer;font-size:11px;opacity:.8}
.ddb-widen:hover{background:var(--dsw-alias-fill-hover,#ffffff14);opacity:1}
.ddb-fileop{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;font-size:11px;background:none;border:none;color:inherit;cursor:pointer;width:100%;text-align:left}
.ddb-fileop:hover{background:var(--dsw-alias-fill-hover,#ffffff14)}
.ddb-notes{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.ddb-note-item{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,#2a2a2a);border-left:3px solid #e5c07b;border-radius:6px;padding:5px 6px;font-size:11px}
.ddb-note-jump{background:none;border:none;color:inherit;cursor:pointer;opacity:.7;font-family:ui-monospace,monospace;font-size:10px;padding:0;white-space:nowrap}
.ddb-note-jump:hover{opacity:1;color:#e5c07b}
.ddb-note-body{flex:1;min-width:0}
.ddb-note-snippet{font-family:ui-monospace,monospace;font-size:10px;opacity:.55;white-space:pre-wrap;word-break:break-all;margin-bottom:2px}
.ddb-note-text{line-height:1.45;white-space:pre-wrap;word-break:break-word}
.ddb-note-del{background:none;border:none;color:inherit;cursor:pointer;opacity:.5;padding:0 2px;font-size:13px}
.ddb-note-del:hover{opacity:1;color:#ff8b8b}
.ddb-note-form{position:fixed;z-index:300;width:240px;background:var(--dsw-alias-bg-elevated,#1c1c1e);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;padding:8px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.ddb-note-form-range{font-size:10px;opacity:.6;font-family:ui-monospace,monospace;margin-bottom:4px;word-break:break-all}
.ddb-note-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base,#111);color:inherit;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:6px;padding:5px 6px;font-size:11px;resize:vertical;font-family:inherit}
.ddb-note-input:focus{outline:none;border-color:var(--dsw-alias-border-l3,#444)}
.ddb-note-form-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}
.ddb-note-save{background:var(--dsw-alias-accent,#4f8cff);color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px}
.ddb-note-save:disabled{opacity:.4;cursor:default}
.ddb-note-cancel{background:none;border:1px solid var(--dsw-alias-border-l2,#333);color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:11px}
.ddb-overlay-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:190}
.ddb-overlay{position:fixed;top:0;right:0;bottom:0;width:min(72vw,1000px);z-index:200;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#141416);border-left:1px solid var(--dsw-alias-border-l2,#333);box-shadow:-12px 0 40px rgba(0,0,0,.5)}
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
@media (max-width: 720px){
.ddb-worksplit{grid-template-columns:1fr}
.ddb-worksplit-tree{display:none}
}`;

    return module.exports;
  },
});
