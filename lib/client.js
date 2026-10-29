/**
 * dsh-remote-anywhere — browser half.
 *
 * Loaded by the DSH client module system (same `window.__ModuleLoader__.load`
 * envelope as every other client plugin). Registers one activity-bar icon and
 * one main page; the page is the Remote Anywhere itself.
 *
 * No build step: this file is plain modern JavaScript plus React from the
 * host's module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-anywhere',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React
    const h = React.createElement

    const PANEL_ID = 'remote-anywhere'
    const PLUGIN_VERSION = '0.2.4'
    const API = {
      targets: '/api/dsh-remote-anywhere/targets',
      refreshTargets: '/api/dsh-remote-anywhere/targets/refresh',
      ls: '/api/dsh-remote-anywhere/ls',
      connect: '/api/dsh-remote-anywhere/connect',
      connections: '/api/dsh-remote-anywhere/connections',
      connection: '/api/dsh-remote-anywhere/connection',
      log: '/api/dsh-remote-anywhere/log',
      disconnect: '/api/dsh-remote-anywhere/disconnect',
      resync: '/api/dsh-remote-anywhere/resync',
      open: '/api/dsh-remote-anywhere/open',
      openTarget: '/api/dsh-remote-anywhere/open-target',
      hosts: '/api/dsh-remote-anywhere/hosts',
      hostSave: '/api/dsh-remote-anywhere/hosts/save',
      hostDelete: '/api/dsh-remote-anywhere/hosts/delete',
      settings: '/api/dsh-remote-anywhere/settings',
      settingsSave: '/api/dsh-remote-anywhere/settings/save',
      remoteWorkspaces: '/api/dsh-remote-anywhere/remote-workspaces',
      remoteWorkspacesProbe: '/api/dsh-remote-anywhere/remote-workspaces/probe',
      sshStatus: '/api/dsh-ssh-workspace/status',
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const CSS = `
.dre-page {
  --dre-bg: var(--dsw-alias-bg-base, #151517);
  --dre-text: var(--dsw-alias-label-primary, #ececf1);
  /* Derive surfaces from the page's own foreground/background instead of
     theme "layer" aliases: some themes (and the codex UI) expose those as a
     mid gray, which made every card look like a disabled control. */
  --dre-panel: color-mix(in srgb, var(--dre-bg) 90%, var(--dre-text) 10%);
  --dre-panel-2: color-mix(in srgb, var(--dre-bg) 84%, var(--dre-text) 16%);
  --dre-border: color-mix(in srgb, var(--dre-text) 14%, transparent);
  --dre-dim: color-mix(in srgb, var(--dre-text) 68%, transparent);
  --dre-faint: color-mix(in srgb, var(--dre-text) 48%, transparent);
  --dre-accent: #7aaaff;
  --dre-accent-soft: color-mix(in srgb, var(--dre-accent) 17%, transparent);
  /* Primary buttons use the plugin's own accent rather than the theme's
     "contrast" fill: that fill is near-white in the dark theme, and its
     inverted label can still resolve to white, producing a blank button. */
  --dre-primary-bg: #4f6bff;
  --dre-primary-bg-hover: #647dff;
  --dre-primary-text: #ffffff;
  --dre-danger: var(--dsw-alias-state-error-primary, #ff6b6b);
  --dre-success: var(--dsw-alias-state-success-primary, #55c777);
  --dre-warn: var(--dsw-alias-state-warn-primary, #e8b45a);
  color: var(--dre-text);
  background: var(--dre-bg);
  font-family: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: 13px;
  line-height: 1.45;
}
.dre-page *, .dre-page *::before, .dre-page *::after { box-sizing: border-box; }
.dre-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 22px;
  border-bottom: 1px solid var(--dre-border);
  flex: 0 0 auto;
  min-height: 64px;
  background: #191a1d;
  background: color-mix(in srgb, var(--dre-bg) 88%, var(--dre-panel) 12%);
}
.dre-header-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.dre-title { font-size: 15px; font-weight: 650; letter-spacing: .01em; display: flex; align-items: center; gap: 8px; }
.dre-subtitle { font-size: 11.5px; color: var(--dre-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dre-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dre-version { font-size: 10.5px; color: var(--dre-faint); border: 1px solid var(--dre-border); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
.dre-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 22px 24px 40px; }
.dre-page.dre-embedded .dre-body { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.dre-section { max-width: 1100px; margin: 0 auto 26px; }
.dre-section-head { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; }
.dre-section-title { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--dre-faint); font-weight: 650; }
.dre-section-count { font-size: 10.5px; color: var(--dre-faint); border: 1px solid var(--dre-border); border-radius: 999px; padding: 0 7px; }
.dre-section-line { height: 1px; flex: 1; background: var(--dre-border); }
.dre-grid { display: grid; gap: 10px; }
.dre-card {
  background: #242528;
  background: var(--dre-panel);
  border: 1px solid #393a3f;
  border: 1px solid var(--dre-border);
  border-radius: 12px;
  padding: 13px 15px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  transition: border-color .12s ease, background .12s ease, transform .12s ease;
}
.dre-card:hover { background: #2e2f34; background: var(--dre-panel-2); border-color: color-mix(in srgb, var(--dre-accent) 42%, var(--dre-border)); }
.dre-card-main { flex: 1 1 auto; min-width: 0; }
.dre-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; min-width: 0; }
.dre-card-title span.dre-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-card-detail { color: var(--dre-dim); font-size: 11.5px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-card-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.dre-card-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
.dre-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dre-faint); flex: 0 0 auto; }
.dre-dot.ok { background: var(--dre-success); }
.dre-dot.busy { background: var(--dre-warn); animation: dre-pulse 1.2s ease-in-out infinite; }
.dre-dot.err { background: var(--dre-danger); }
.dre-dot.muted { background: var(--dre-faint); opacity: .6; }
@keyframes dre-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.dre-badge { font-size: 10.5px; border: 1px solid var(--dre-border); border-radius: 999px; padding: 1px 7px; color: var(--dre-dim); white-space: nowrap; }
.dre-badge.warn { color: var(--dre-warn); border-color: color-mix(in srgb, var(--dre-warn) 38%, transparent); }
.dre-badge.ok { color: var(--dre-success); border-color: color-mix(in srgb, var(--dre-success) 38%, transparent); }
.dre-badge.accent { color: var(--dre-accent); border-color: color-mix(in srgb, var(--dre-accent) 45%, transparent); background: var(--dre-accent-soft); }
.dre-btn {
  appearance: none;
  border: 1px solid #3c3d42;
  border: 1px solid var(--dre-border);
  background: #2a2b30;
  background: var(--dre-panel-2);
  color: var(--dre-text);
  border-radius: 8px;
  padding: 5px 11px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.5;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
  white-space: nowrap;
}
.dre-btn:hover { background: rgba(122, 170, 255, .16); background: var(--dre-accent-soft); border-color: color-mix(in srgb, var(--dre-accent) 40%, var(--dre-border)); }
.dre-btn:focus-visible { outline: 2px solid var(--dre-accent); outline-offset: 2px; }
.dre-btn:disabled { opacity: .45; cursor: default; }
.dre-btn.primary { background: var(--dre-primary-bg); border-color: var(--dre-primary-bg); color: var(--dre-primary-text); font-weight: 600; }
.dre-btn.primary:hover { background: var(--dre-primary-bg-hover); border-color: var(--dre-primary-bg-hover); filter: none; }
.dre-btn.ghost { background: transparent; }
.dre-btn.danger { color: var(--dre-danger); border-color: color-mix(in srgb, var(--dre-danger) 35%, var(--dre-border)); }
.dre-btn.danger:hover { background: color-mix(in srgb, var(--dre-danger) 12%, transparent); }
.dre-btn.sm { padding: 3px 8px; font-size: 11px; border-radius: 7px; }
.dre-icon-btn { width: 28px; height: 28px; padding: 0; justify-content: center; }
.dre-empty {
  border: 1px dashed var(--dre-border);
  border-radius: 14px;
  padding: 34px 20px;
  text-align: center;
  color: var(--dre-dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.dre-empty strong { color: var(--dre-text); font-size: 14px; font-weight: 600; }
.dre-empty p { margin: 0; max-width: 540px; font-size: 12px; }
.dre-hint {
  border: 1px solid color-mix(in srgb, var(--dre-accent) 30%, var(--dre-border));
  background: rgba(79, 107, 255, .12);
  background: var(--dre-accent-soft);
  border-radius: 10px;
  padding: 10px 12px;
  color: var(--dre-dim);
  font-size: 11.5px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.dre-hint strong { color: var(--dre-text); font-weight: 600; }
.dre-connbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dre-border);
  flex: 0 0 auto;
  background: #202124;
  background: var(--dre-panel);
  min-height: 48px;
}
.dre-connbar-main { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1 1 auto; }
.dre-connbar-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dre-connbar-path { color: var(--dre-dim); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dre-connbar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.dre-iframe-wrap { flex: 1 1 auto; min-height: 0; position: relative; background: var(--dre-bg); display: flex; }
.dre-iframe { border: 0; width: 100%; height: 100%; flex: 1 1 auto; background: var(--dre-bg); }
.dre-progress { padding: 22px 24px; max-width: 780px; margin: 0 auto; width: 100%; }
.dre-progress-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.dre-spinner {
  width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dre-accent) 30%, transparent);
  border-top-color: var(--dre-accent);
  animation: dre-spin .8s linear infinite;
  flex: 0 0 auto;
}
@keyframes dre-spin { to { transform: rotate(360deg); } }
.dre-steps { display: flex; flex-direction: column; border: 1px solid var(--dre-border); border-radius: 12px; overflow: hidden; background: var(--dre-panel); }
.dre-step { display: flex; align-items: flex-start; gap: 11px; padding: 11px 14px; border-top: 1px solid var(--dre-border); }
.dre-step:first-child { border-top: 0; }
.dre-step-icon { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--dre-border); display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; margin-top: 1px; font-size: 10px; color: var(--dre-faint); }
.dre-step-icon.done { background: color-mix(in srgb, var(--dre-success) 18%, transparent); border-color: var(--dre-success); color: var(--dre-success); }
.dre-step-icon.running { border-color: var(--dre-accent); }
.dre-step-icon.error { background: color-mix(in srgb, var(--dre-danger) 18%, transparent); border-color: var(--dre-danger); color: var(--dre-danger); }
.dre-step-main { min-width: 0; flex: 1 1 auto; }
.dre-step-label { font-weight: 550; font-size: 12.5px; }
.dre-step-detail { color: var(--dre-dim); font-size: 11.5px; margin-top: 1px; overflow-wrap: anywhere; }
.dre-report { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.dre-log-head { display: flex; align-items: center; gap: 8px; margin-top: 16px; min-height: 24px; }
.dre-log-head .dre-grow { flex: 1 1 auto; }
.dre-log-title { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dre-faint); font-weight: 650; }
.dre-log-hint { font-size: 10.5px; color: var(--dre-faint); }
.dre-log {
  margin-top: 6px;
  border: 1px solid var(--dre-border);
  border-radius: 10px;
  background: #0b0c0f;
  color: #cfd3dc;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  max-height: 260px;
  overflow: auto;
  padding: 10px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dre-error-box {
  border: 1px solid color-mix(in srgb, var(--dre-danger) 40%, var(--dre-border));
  background: color-mix(in srgb, var(--dre-danger) 8%, var(--dre-panel));
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.dre-error-box strong { color: var(--dre-danger); }
.dre-modal-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0,0,0,.48);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  backdrop-filter: blur(2px);
}
.dre-modal {
  width: min(620px, 96vw);
  max-height: min(82vh, 760px);
  background: #202124;
  background: var(--dre-panel);
  color: var(--dre-text);
  border: 1px solid #393a3f;
  border: 1px solid var(--dre-border);
  border-radius: 15px;
  box-shadow: 0 24px 70px rgba(0,0,0,.45);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.dre-modal.wide { width: min(780px, 96vw); }
.dre-modal-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 12px; border-bottom: 1px solid var(--dre-border); }
.dre-modal-title { font-size: 14.5px; font-weight: 650; }
.dre-modal-sub { color: var(--dre-dim); font-size: 11.5px; margin-top: 2px; overflow-wrap: anywhere; }
.dre-modal-body { padding: 16px 18px; overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.dre-modal-foot { padding: 12px 18px 16px; border-top: 1px solid var(--dre-border); display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.dre-field { display: flex; flex-direction: column; gap: 5px; }
.dre-field label { font-size: 11.5px; color: var(--dre-dim); font-weight: 550; }
.dre-field .dre-field-hint { font-size: 10.5px; color: var(--dre-faint); }
.dre-input, .dre-select {
  width: 100%;
  background: #151517;
  background: var(--dre-bg);
  color: var(--dre-text);
  border: 1px solid #393a3f;
  border: 1px solid var(--dre-border);
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
}
.dre-input:focus, .dre-select:focus { border-color: var(--dre-accent); box-shadow: 0 0 0 2px var(--dre-accent-soft); }
.dre-row { display: flex; gap: 10px; }
.dre-row > * { flex: 1 1 0; min-width: 0; }
.dre-check { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0; }
.dre-check input { margin-top: 3px; accent-color: var(--dre-accent); }
.dre-check-text { display: flex; flex-direction: column; gap: 1px; }
.dre-check-text strong { font-size: 12.5px; font-weight: 550; }
.dre-check-text span { font-size: 11px; color: var(--dre-dim); }
.dre-list { border: 1px solid var(--dre-border); border-radius: 10px; overflow: auto; max-height: 290px; background: #151517; background: var(--dre-bg); }
.dre-list-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--dre-border); cursor: pointer; font-size: 12px; }
.dre-list-row:first-child { border-top: 0; }
.dre-list-row:hover { background: var(--dre-accent-soft); }
.dre-list-row .dre-list-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-list-empty { padding: 14px; color: var(--dre-faint); font-size: 11.5px; text-align: center; }
.dre-pathbar { display: flex; align-items: center; gap: 6px; }
.dre-pathbar .dre-input { flex: 1 1 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.dre-note { color: var(--dre-faint); font-size: 11px; }
.dre-conn-list { display: grid; gap: 8px; }
.dre-conn-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border: 1px solid #393a3f; border-radius: 10px;
  border: 1px solid var(--dre-border);
  background: #242528; background: var(--dre-panel); cursor: pointer;
}
.dre-conn-row:hover { border-color: color-mix(in srgb, var(--dre-accent) 42%, var(--dre-border)); }
.dre-conn-row .dre-conn-name { font-weight: 600; font-size: 12.5px; }
.dre-conn-row .dre-conn-sub { color: var(--dre-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-conn-row .dre-grow { flex: 1 1 auto; min-width: 0; }
.dre-toolbar-sep { width: 1px; height: 18px; background: var(--dre-border); }
.dre-kbd { font-family: ui-monospace, monospace; font-size: 10.5px; border: 1px solid var(--dre-border); border-radius: 5px; padding: 0 4px; color: var(--dre-faint); }
.dre-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dre-warn { color: var(--dre-warn); }
.dre-danger { color: var(--dre-danger); }
.dre-success { color: var(--dre-success); }
.dre-dim { color: var(--dre-dim); }
.dre-link { color: var(--dre-accent); cursor: pointer; text-decoration: none; }
.dre-link:hover { text-decoration: underline; }
.dre-checkbox-row { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dre-dim); }
.dre-checkbox-row input { accent-color: var(--dre-accent); }
@media (max-width: 720px) {
  .dre-header { align-items: flex-start; flex-direction: column; }
  .dre-header-actions { justify-content: flex-start; }
  .dre-card { flex-direction: column; }
  .dre-card-actions { justify-content: flex-start; }
}

/* ---- remote workspace status (sidebar row badge + hover card) ---- */
.dre-ws-badge {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 1px;
  pointer-events: none;
}
.dre-ws-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b8f96) 55%, transparent);
}
.dre-ws-badge[data-state="connected"]::before,
.dre-ws-badge[data-state="hot"]::before {
  background: #3ecf8e;
  box-shadow: 0 0 0 2px color-mix(in srgb, #3ecf8e 16%, transparent);
}
.dre-ws-badge[data-state="checking"]::before {
  width: 10px;
  height: 10px;
  background: transparent;
  border: 2px solid color-mix(in srgb, #7aaaff 24%, transparent);
  border-top-color: #7aaaff;
  animation: dre-ws-spin .7s linear infinite;
}
.dre-ws-badge[data-state="failed"]::before { background: #ff6b6b; }
.dre-ws-badge[data-state="disabled"]::before { background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b8f96) 45%, transparent); }
@keyframes dre-ws-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dre-ws-badge[data-state="checking"]::before,
  .dre-ws-pill-spinner { animation-duration: 1.6s; }
}

.dre-ws-card {
  position: fixed;
  z-index: 10060;
  box-sizing: border-box;
  width: 360px;
  max-width: calc(100vw - 16px);
  padding: 12px 14px 10px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 14%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #1b1c1f) 92%, var(--dsw-alias-label-primary, #fff) 8%);
  color: var(--dsw-alias-label-primary, #ececf1);
  box-shadow: 0 14px 36px rgba(0, 0, 0, .38), 0 2px 8px rgba(0, 0, 0, .22);
  font: 13px/1.45 var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif);
  text-align: left;
  animation: dre-ws-card-in 120ms cubic-bezier(.16, 1, .3, 1);
}
@keyframes dre-ws-card-in {
  from { opacity: 0; transform: translateY(4px); }
}
.dre-ws-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dre-ws-card-icon { flex: none; width: 16px; height: 16px; display: inline-flex; color: var(--dsw-alias-label-secondary, #a2a7ad); }
.dre-ws-card-icon svg { width: 16px; height: 16px; }
.dre-ws-card-title { flex: 1 1 auto; min-width: 0; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-ws-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.dre-ws-pill[data-state="connected"],
.dre-ws-pill[data-state="hot"] {
  color: #3ecf8e;
  background: color-mix(in srgb, #3ecf8e 12%, transparent);
  border-color: color-mix(in srgb, #3ecf8e 26%, transparent);
}
.dre-ws-pill[data-state="checking"] {
  color: #7aaaff;
  background: color-mix(in srgb, #7aaaff 12%, transparent);
  border-color: color-mix(in srgb, #7aaaff 26%, transparent);
}
.dre-ws-pill[data-state="failed"] {
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
  border-color: color-mix(in srgb, #ff6b6b 26%, transparent);
}
.dre-ws-pill[data-state="disabled"],
.dre-ws-pill[data-state="unknown"] {
  color: var(--dsw-alias-label-tertiary, #8b8f96);
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b8f96) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b8f96) 22%, transparent);
}
.dre-ws-pill-spinner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, #7aaaff 30%, transparent);
  border-top-color: #7aaaff;
  animation: dre-ws-spin .7s linear infinite;
}
.dre-ws-card-rows {
  display: grid;
  gap: 4px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 10%, transparent);
}
.dre-ws-row { display: flex; gap: 10px; min-width: 0; font-size: 12px; line-height: 18px; }
.dre-ws-row-label { flex: 0 0 58px; color: var(--dsw-alias-label-tertiary, #8b8f96); }
.dre-ws-row-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dre-ws-row-value.dre-ws-mono {
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 11.5px;
}
.dre-ws-log { margin-top: 9px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 10%, transparent); }
.dre-ws-log-title { margin-bottom: 5px; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #8b8f96); }
.dre-ws-log-lines { display: grid; gap: 2px; max-height: 132px; overflow: auto; }
.dre-ws-log-line {
  display: flex;
  gap: 8px;
  font: 11px/16px var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  color: var(--dsw-alias-label-secondary, #a9adb4);
}
.dre-ws-log-time { flex: none; color: var(--dsw-alias-label-tertiary, #7c8087); }
.dre-ws-log-text { min-width: 0; overflow-wrap: anywhere; }
.dre-ws-log-line[data-level="ok"] .dre-ws-log-text { color: #3ecf8e; }
.dre-ws-log-line[data-level="err"] .dre-ws-log-text { color: #ff6b6b; }
.dre-ws-log-empty { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8b8f96); }
.dre-ws-card-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8b8f96);
}
body.dre-ws-card-open .dcu-wb-tip { display: none !important; }
body.dre-ws-card-open [class*="_hoverContent"] { display: none !important; }
`

    function installStyles () {
      if (document.getElementById('dsh-remote-anywhere-style') !== null) return () => {}
      const style = document.createElement('style')
      style.id = 'dsh-remote-anywhere-style'
      style.textContent = CSS
      document.head.append(style)
      return () => { style.remove() }
    }

    // ---------------------------------------------------------------------
    // API + store
    // ---------------------------------------------------------------------
    async function fetchJson (url, init) {
      const response = await fetch(url, init)
      const text = await response.text().catch(() => '')
      let parsed
      try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = {} }
      if (!response.ok) {
        throw new Error(typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : `${response.status} ${response.statusText}`)
      }
      return parsed
    }

    const state = {
      loaded: false,
      targets: null,
      connections: [],
      settings: null,
      selected: null,
      error: null,
      busy: false,
    }
    let snapshotVersion = 0
    const listeners = new Set()
    function bump () {
      snapshotVersion += 1
      for (const listener of [...listeners]) listener()
    }
    function subscribe (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    function useExplorer () {
      const version = useSyncExternalStore(subscribe, () => snapshotVersion, () => snapshotVersion)
      return { ...state, version }
    }
    function setError (error) {
      state.error = error instanceof Error ? error.message : (error === null ? null : String(error))
      bump()
      if (state.error !== null) {
        window.setTimeout(() => {
          if (state.error !== null) {
            state.error = null
            bump()
          }
        }, 8000)
      }
    }

    let loadPromise
    async function loadAll () {
      if (loadPromise !== undefined) return loadPromise
      loadPromise = (async () => {
        try {
          const [targets, connections, settings] = await Promise.all([
            fetchJson(API.targets),
            fetchJson(API.connections),
            fetchJson(API.settings),
          ])
          state.targets = targets
          state.connections = connections.connections ?? []
          state.settings = settings.settings ?? null
          state.loaded = true
        } catch (error) {
          setError(error)
        } finally {
          loadPromise = undefined
          bump()
        }
      })()
      return loadPromise
    }

    async function refreshConnections () {
      try {
        const payload = await fetchJson(API.connections)
        state.connections = payload.connections ?? []
        bump()
      } catch { /* transient; the next poll retries */ }
    }

    async function refreshTargets (force = true) {
      try {
        state.busy = true
        bump()
        const payload = await fetchJson(force ? API.refreshTargets : API.targets, force ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined)
        state.targets = payload
        state.loaded = true
      } catch (error) {
        setError(error)
      } finally {
        state.busy = false
        bump()
      }
    }

    async function pollTargets () {
      try {
        const payload = await fetchJson(API.targets)
        state.targets = payload
        state.loaded = true
        bump()
      } catch { /* transient; the next poll retries */ }
    }

    async function connectTarget (targetId, path, options) {
      const connection = await fetchJson(API.connect, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId, path, options }),
      })
      state.connections = [connection, ...state.connections.filter(item => item.id !== connection.id)]
      state.selected = connection.id
      bump()
      return connection
    }

    async function disconnectConnection (id) {
      const connection = await fetchJson(API.disconnect, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      state.connections = state.connections.map(item => item.id === id ? { ...item, ...connection } : item)
      if (state.selected === id && connection.state === 'closed') state.selected = null
      bump()
      return connection
    }

    async function resyncConnection (id) {
      const connection = await fetchJson(API.resync, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      state.connections = state.connections.map(item => item.id === id ? { ...item, ...connection } : item)
      bump()
      return connection
    }

    async function openLocalConnection (id, kind) {
      return await fetchJson(API.open, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, kind }),
      })
    }

    async function openTargetAction (targetId, kind) {
      return await fetchJson(API.openTarget, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId, kind }),
      })
    }

    async function saveSettings (settings) {
      const payload = await fetchJson(API.settingsSave, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      })
      state.settings = payload.settings
      bump()
      return payload.settings
    }

    async function saveHost (payload) {
      const result = await fetchJson(API.hostSave, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await refreshTargets(true)
      return result
    }

    async function deleteHost (alias) {
      await fetchJson(API.hostDelete, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias }),
      })
      await refreshTargets(true)
    }

    async function listFolder (targetId, path) {
      const url = `${API.ls}?targetId=${encodeURIComponent(targetId)}&path=${encodeURIComponent(path ?? '')}`
      return await fetchJson(url)
    }

    async function loadLog (id) {
      const payload = await fetchJson(`${API.log}?id=${encodeURIComponent(id)}`)
      return payload.log ?? ''
    }

    // ---------------------------------------------------------------------
    // Small presentational helpers
    // ---------------------------------------------------------------------
    function cls (...names) {
      return names.filter(name => typeof name === 'string' && name !== '').join(' ')
    }

    function shortPath (path, max = 64) {
      const text = String(path ?? '')
      if (text.length <= max) return text
      const head = text.slice(0, Math.max(10, Math.floor(max / 2) - 2))
      const tail = text.slice(-Math.max(10, Math.floor(max / 2) - 2))
      return `${head}…${tail}`
    }

    function stateLabel (connection) {
      if (connection.state === 'ready') return '已连接'
      if (connection.state === 'working') return '连接中'
      if (connection.state === 'error') return '失败'
      if (connection.state === 'closed') return '已断开'
      return connection.state
    }

    function stateDot (connection) {
      if (connection.state === 'ready') return 'ok'
      if (connection.state === 'working') return 'busy'
      if (connection.state === 'error') return 'err'
      return 'muted'
    }

    function targetConnection (connections, targetId) {
      return connections.find(connection => connection.targetId === targetId && (connection.state === 'ready' || connection.state === 'working'))
    }

    function Button ({ children, variant, size, icon, ...rest }) {
      return h('button', {
        type: 'button',
        ...rest,
        className: cls('dre-btn', variant, size, rest.className),
      }, icon === undefined ? null : icon, children)
    }

    function Badge ({ children, tone }) {
      return h('span', { className: cls('dre-badge', tone) }, children)
    }

    function Spinner () {
      return h('span', { className: 'dre-spinner', 'aria-hidden': 'true' })
    }

    function Modal ({ title, subtitle, children, footer, onClose, wide }) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        className: 'dre-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      }, h('div', { className: cls('dre-modal', wide ? 'wide' : '') },
        h('div', { className: 'dre-modal-head' },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'dre-modal-title' }, title),
            subtitle === undefined ? null : h('div', { className: 'dre-modal-sub' }, subtitle)),
          h('button', { type: 'button', className: 'dre-btn ghost dre-icon-btn', onClick: onClose, 'aria-label': '关闭' }, '×')),
        h('div', { className: 'dre-modal-body' }, children),
        footer === undefined ? null : h('div', { className: 'dre-modal-foot' }, footer)))
    }

    function Field ({ label, hint, children }) {
      return h('div', { className: 'dre-field' },
        h('label', null, label),
        children,
        hint === undefined ? null : h('span', { className: 'dre-field-hint' }, hint))
    }

    function Check ({ checked, onChange, title, detail }) {
      return h('label', { className: 'dre-check' },
        h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
        h('span', { className: 'dre-check-text' },
          h('strong', null, title),
          detail === undefined ? null : h('span', null, detail)))
    }

    function IconRemote ({ size = 18 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2.2 }),
      h('path', { d: 'M8 21h8M12 17v4' }),
      h('path', { d: 'M7.2 9.4l3.2 2.1-3.2 2.1' }),
      h('path', { d: 'M12.8 13.6h3.6' }))
    }

    function IconRefresh ({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }))
    }

    function IconPlus ({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 5v14M5 12h14' }))
    }

    function IconBack ({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M15 18l-6-6 6-6' }))
    }

    function IconExternal ({ size = 13 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4l-9 9' }),
        h('path', { d: 'M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4' }))
    }

    function IconDisk ({ size = 13 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }))
    }

    // ---------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------
    function ExplorerPage () {
      const explorer = useExplorer()
      const [dialog, setDialog] = useState(null)
      const [showLog, setShowLog] = useState(false)

      useEffect(() => {
        void loadAll()
      }, [])

      // A first load can race the Web GUI process coming up (or a transient
      // 502 from a proxy); keep trying quietly until the first payload lands.
      useEffect(() => {
        if (explorer.loaded) return undefined
        const timer = window.setInterval(() => { void loadAll() }, 2500)
        return () => window.clearInterval(timer)
      }, [explorer.loaded])

      // `wsl.exe -l -q` can take a long time on a cold/wedged WSL service.
      // The host returns SSH hosts immediately and discovers WSL in the
      // background; poll its cheap GET until the list settles.
      useEffect(() => {
        if (explorer.targets?.wslPending !== true) return undefined
        const timer = window.setInterval(() => { void pollTargets() }, 2500)
        return () => window.clearInterval(timer)
      }, [explorer.targets?.wslPending])

      useEffect(() => {
        const timer = window.setInterval(() => { void refreshConnections() }, 4000)
        return () => window.clearInterval(timer)
      }, [])

      const hasWorking = explorer.connections.some(connection => connection.state === 'working')
      useEffect(() => {
        if (!hasWorking) return undefined
        const timer = window.setInterval(() => { void refreshConnections() }, 800)
        return () => window.clearInterval(timer)
      }, [hasWorking])

      const active = explorer.connections.find(connection => connection.id === explorer.selected) ?? null
      useEffect(() => {
        setShowLog(false)
      }, [active === null ? '' : active.id])

      const openConnection = useCallback((id) => {
        state.selected = id
        bump()
      }, [])

      const handleConnect = useCallback(async (target, path, options) => {
        try {
          state.busy = true
          bump()
          await connectTarget(target.id, path, options)
          setDialog(null)
        } catch (error) {
          setError(error)
        } finally {
          state.busy = false
          bump()
        }
      }, [])

      const handleDisconnect = useCallback(async (id) => {
        try {
          await disconnectConnection(id)
        } catch (error) {
          setError(error)
        }
      }, [])

      const handleResync = useCallback(async (id) => {
        try {
          await resyncConnection(id)
        } catch (error) {
          setError(error)
        }
      }, [])

      const handleOpenLocal = useCallback(async (id, kind) => {
        try {
          await openLocalConnection(id, kind)
        } catch (error) {
          setError(error)
        }
      }, [])

      const handleOpenTarget = useCallback(async (target, kind) => {
        try {
          await openTargetAction(target.id, kind)
        } catch (error) {
          setError(error)
        }
      }, [])

      const targetForActive = active === null || explorer.targets === null
        ? null
        : [...(explorer.targets.ssh ?? []), ...(explorer.targets.wsl ?? [])].find(target => target.id === active.targetId) ?? null

      return h('div', { className: cls('dre-page', active !== null && active.state === 'ready' ? 'dre-embedded' : '') },
        active === null
          ? h(Header, {
            explorer,
            onRefresh: () => void refreshTargets(true),
            onAddHost: () => setDialog({ kind: 'host' }),
            onSettings: () => setDialog({ kind: 'settings' }),
          })
          : h(ConnectionBar, {
            connection: active,
            target: targetForActive,
            onBack: () => { state.selected = null; bump() },
            onDisconnect: () => void handleDisconnect(active.id),
            onResync: () => void handleResync(active.id),
            onOpenLocal: (kind) => void handleOpenLocal(active.id, kind),
            onToggleLog: () => setShowLog(value => !value),
            showLog,
          }),
        active === null
          ? h(TargetsBody, {
            explorer,
            onConnect: (target) => setDialog({ kind: 'connect', target }),
            onEdit: (target) => setDialog({ kind: 'host', target }),
            onOpenTarget: (target, kind) => void handleOpenTarget(target, kind),
            onOpenConnection: openConnection,
            onRefresh: () => void refreshTargets(true),
          })
          : h(ConnectionBody, {
            connection: active,
            showLog,
            onDisconnect: () => void handleDisconnect(active.id),
            onRetry: () => { state.selected = null; bump() },
          }),
        dialog?.kind === 'connect' ? h(ConnectDialog, {
          target: dialog.target,
          settings: explorer.settings,
          busy: explorer.busy,
          onClose: () => setDialog(null),
          onConnect: (path, options) => void handleConnect(dialog.target, path, options),
        }) : null,
        dialog?.kind === 'host' ? h(HostDialog, {
          target: dialog.target,
          onClose: () => setDialog(null),
          onSaved: () => setDialog(null),
          onDeleted: () => setDialog(null),
        }) : null,
        dialog?.kind === 'settings' ? h(SettingsDialog, {
          settings: explorer.settings,
          local: explorer.targets?.local,
          onClose: () => setDialog(null),
          onSaved: () => setDialog(null),
        }) : null,
        explorer.error === null ? null : h('div', {
          style: {
            position: 'fixed', right: '20px', bottom: '20px', zIndex: 70,
            maxWidth: '460px', padding: '10px 14px', borderRadius: '10px',
            border: '1px solid var(--dre-danger)', background: 'var(--dre-panel)',
            color: 'var(--dre-text)', boxShadow: '0 12px 40px rgba(0,0,0,.35)', fontSize: '12px',
          },
          role: 'alert',
        }, h('span', { className: 'dre-danger', style: { fontWeight: 600 } }, '操作失败：'), explorer.error))
    }

    function Header ({ explorer, onRefresh, onAddHost, onSettings }) {
      const local = explorer.targets?.local
      return h('div', { className: 'dre-header' },
        h('div', { className: 'dre-header-main' },
          h('div', { className: 'dre-title' }, h(IconRemote, { size: 17 }), '远程资源管理器'),
          h('div', { className: 'dre-subtitle' }, 'SSH 主机 与 WSL 发行版 · 在远端安装并运行 dsh · 本地窗口内同步对话')),
        h('div', { className: 'dre-header-actions' },
          local?.version ? h('span', { className: 'dre-version' }, `本地 dsh ${local.version}`) : null,
          h('span', { className: 'dre-version' }, `Remote Anywhere ${PLUGIN_VERSION}`),
          h(Button, { variant: 'ghost', size: 'sm', onClick: onRefresh, icon: h(IconRefresh, null), disabled: explorer.busy }, explorer.busy ? '刷新中…' : '刷新'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: onSettings }, '设置'),
          h(Button, { variant: 'primary', size: 'sm', onClick: onAddHost, icon: h(IconPlus, null) }, '添加 SSH 主机')))
    }

    function ConnectionBar ({ connection, target, onBack, onDisconnect, onResync, onOpenLocal, onToggleLog, showLog }) {
      return h('div', { className: 'dre-connbar' },
        h('button', { type: 'button', className: 'dre-btn ghost dre-icon-btn', onClick: onBack, 'aria-label': '返回' }, h(IconBack, null)),
        h('span', { className: cls('dre-dot', stateDot(connection)) }),
        h('div', { className: 'dre-connbar-main' },
          h('span', { className: 'dre-connbar-title' }, connection.targetName ?? target?.name ?? '远端'),
          h('span', { className: 'dre-connbar-path' }, shortPath(connection.workspace, 70)),
          h(Badge, { tone: connection.state === 'ready' ? 'ok' : connection.state === 'error' ? 'warn' : 'accent' }, stateLabel(connection)),
          connection.dshVersion === undefined ? null : h(Badge, null, `dsh ${connection.dshVersion}`),
          connection.node === undefined ? null : h(Badge, null, connection.node),
          connection.localPort === undefined ? null : h(Badge, null, `127.0.0.1:${connection.localPort}`)),
        h('div', { className: 'dre-connbar-actions' },
          connection.state === 'ready' ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenLocal('vscode'),
            title: '在 VS Code 中以 Remote-SSH / WSL 状态打开这个远端目录',
          }, 'VS Code') : null,
          connection.state === 'ready' ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenLocal('terminal'),
            title: '打开一个连接到远端主机的终端',
          }, '终端') : null,
          connection.state === 'ready' && connection.targetKind === 'wsl' ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenLocal('explorer'),
            title: '在 Windows 资源管理器中打开这个 WSL 目录',
          }, '文件') : null,
          connection.state === 'ready' ? h('span', { className: 'dre-toolbar-sep' }) : null,
          connection.state === 'ready' ? h(Button, { size: 'sm', variant: 'ghost', onClick: onToggleLog }, showLog ? '隐藏日志' : '日志') : null,
          connection.state === 'ready' ? h(Button, {
            size: 'sm', variant: 'ghost', icon: h(IconExternal, null),
            onClick: () => window.open(connection.url, '_blank', 'noopener,noreferrer'),
          }, '新标签页') : null,
          connection.state === 'ready' ? h(Button, { size: 'sm', variant: 'ghost', onClick: onResync }, '重新同步') : null,
          h(Button, { size: 'sm', variant: 'danger', onClick: onDisconnect }, '断开')))
    }

    function TargetsBody ({ explorer, onConnect, onEdit, onOpenTarget, onOpenConnection, onRefresh }) {
      if (!explorer.loaded) {
        return h('div', { className: 'dre-body' }, h('div', { className: 'dre-progress' },
          h('div', { className: 'dre-progress-head' }, h(Spinner, null), h('span', null, '正在读取主机与 WSL 发行版…'))))
      }
      const ssh = explorer.targets?.ssh ?? []
      const wsl = explorer.targets?.wsl ?? []
      const connections = explorer.connections.filter(connection => connection.state !== 'closed')
      return h('div', { className: 'dre-body' },
        connections.length === 0 ? null : h('div', { className: 'dre-section' },
          h('div', { className: 'dre-section-head' },
            h('span', { className: 'dre-section-title' }, '连接'),
            h('span', { className: 'dre-section-count' }, connections.length),
            h('span', { className: 'dre-section-line' })),
          h('div', { className: 'dre-conn-list' }, connections.map(connection => h('div', {
            key: connection.id,
            className: 'dre-conn-row',
            onClick: () => onOpenConnection(connection.id),
          },
          h('span', { className: cls('dre-dot', stateDot(connection)) }),
          h('div', { className: 'dre-grow' },
            h('div', { className: 'dre-conn-name' }, connection.targetName ?? connection.targetId),
            h('div', { className: 'dre-conn-sub' }, `${stateLabel(connection)} · ${shortPath(connection.workspace, 60)}${connection.error ? ` · ${connection.error}` : ''}`)))))),
        h('div', { className: 'dre-section' },
          h('div', { className: 'dre-section-head' },
            h('span', { className: 'dre-section-title' }, 'SSH 主机'),
            h('span', { className: 'dre-section-count' }, ssh.length),
            h('span', { className: 'dre-section-line' })),
          ssh.length === 0
            ? h('div', { className: 'dre-empty' },
              h(IconRemote, { size: 28 }),
              h('strong', null, '还没有 SSH 主机'),
              h('p', null, '可以添加一台主机，或先在 ~/.ssh/config 中配置一个 Host；已有的 dsh-ssh-workspace 主机也会出现在这里。'),
              h(Button, { variant: 'primary', size: 'sm', onClick: onRefresh }, '重新扫描'))
            : h('div', { className: 'dre-grid' }, ssh.map(target => h(TargetCard, {
              key: target.id,
              target,
              connection: targetConnection(connections, target.id),
              onConnect: () => onConnect(target),
              onOpenTarget: (kind) => onOpenTarget(target, kind),
              onOpenConnection: onOpenConnection,
              onEdit: () => onEdit(target),
            })))),
        h('div', { className: 'dre-section' },
          h('div', { className: 'dre-section-head' },
            h('span', { className: 'dre-section-title' }, 'WSL 发行版'),
            h('span', { className: 'dre-section-count' }, wsl.length),
            h('span', { className: 'dre-section-line' })),
          wsl.length === 0
            ? (explorer.targets?.wslPending === true
                ? h('div', { className: 'dre-empty' },
                  h(Spinner, null),
                  h('strong', null, '正在检测 WSL 发行版…'),
                  h('p', null, 'WSL 服务冷启动时 wsl.exe 可能较慢；SSH 主机已先显示，检测完成后这里会自动更新。'))
                : h('div', { className: 'dre-empty' },
                  h('strong', null, '没有检测到 WSL 发行版'),
                  h('p', null, 'WSL 目标在 Windows 主机上自动发现，无需 sshd。安装一个发行版后点击「刷新」。')))
            : h(React.Fragment, null,
              h('div', { className: 'dre-grid' }, wsl.map(target => h(TargetCard, {
                key: target.id,
                target,
                connection: targetConnection(connections, target.id),
                onConnect: () => onConnect(target),
                onOpenTarget: (kind) => onOpenTarget(target, kind),
                onOpenConnection: onOpenConnection,
              }))),
              explorer.targets?.wslPending === true
                ? h('div', { className: 'dre-note', style: { marginTop: '6px' } }, '正在刷新 WSL 列表…')
                : null)),
        h('div', { className: 'dre-section' },
          h('div', { className: 'dre-hint' },
            h('span', { style: { fontSize: '14px', lineHeight: '18px' } }, 'ⓘ'),
            h('div', null,
              h('strong', null, '首次连接会自动准备远端环境。'),
              '插件会在远端用户的 ~/.dsh/remote-bin 安装一份 dsh，并把本地的模型配置、凭据、插件清单、技能和提示词同步到远端 ~/.dsh；随后在所选目录启动 dsh，本地通过 127.0.0.1 端口转发嵌入它的界面。',
              h('div', { style: { marginTop: '4px' } }, '远端需要 Node.js 22/24 与 npm。模型凭据会复制到远端，请只在可信主机上使用。'))))
      )
    }

    function TargetCard ({ target, connection, onConnect, onOpenTarget, onOpenConnection, onEdit }) {
      const status = target.kind === 'wsl'
        ? (target.available === false ? 'muted' : 'ok')
        : (target.keyReady === false ? 'err' : 'ok')
      const isConfig = target.source === 'ssh-config'
      const connectable = target.available !== false && target.system !== true
      return h('div', { className: 'dre-card' },
        h('span', { className: cls('dre-dot', connection?.state === 'working' ? 'busy' : connection?.state === 'ready' ? 'ok' : status), style: { marginTop: '7px' } }),
        h('div', { className: 'dre-card-main' },
          h('div', { className: 'dre-card-title' },
            h('span', { className: 'dre-name' }, target.name),
            target.kind === 'wsl' ? h(Badge, { tone: 'accent' }, 'WSL') : null,
            target.keyReady === false ? h(Badge, { tone: 'warn' }, '密钥缺失') : null,
            target.available === false ? h(Badge, { tone: 'warn' }, '不可用') : null,
            target.system === true ? h(Badge, null, '系统发行版') : null),
          h('div', { className: 'dre-card-detail' }, target.detail),
          h('div', { className: 'dre-card-meta' },
            target.kind === 'ssh' ? h(Badge, null, target.auth === 'password' ? '密码认证' : target.auth === 'key' ? '密钥认证' : 'SSH Agent') : null,
            target.kind === 'ssh' ? h(Badge, null, isConfig ? '~/.ssh/config' : '插件主机') : null,
            target.home ? h(Badge, null, shortPath(target.home, 34)) : null,
            target.proxyJump ? h(Badge, { tone: 'warn' }, `ProxyJump 不支持`) : null,
            target.error ? h(Badge, { tone: 'warn' }, target.error) : null)),
        h('div', { className: 'dre-card-actions' },
          connection?.state === 'ready'
            ? h(Button, { variant: 'primary', size: 'sm', onClick: () => onOpenConnection(connection.id) }, '打开')
            : connection?.state === 'working'
              ? h(Button, { size: 'sm', onClick: () => onOpenConnection(connection.id) }, '查看进度')
              : connectable
                ? h(Button, { variant: 'primary', size: 'sm', onClick: onConnect, icon: h(IconDisk, null) }, '连接并打开')
                : h('span', { className: 'dre-note' }, target.system === true ? '系统发行版，仅列出' : '当前不可连接'),
          connectable ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenTarget('vscode'),
            title: '直接在 VS Code 中打开远端 home（Remote-SSH / Remote-WSL）',
          }, 'VS Code') : null,
          connectable ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenTarget('terminal'),
            title: '直接从本地打开这个目标的远端终端',
          }, '终端') : null,
          connectable && target.kind === 'wsl' ? h(Button, {
            size: 'sm', variant: 'ghost', onClick: () => onOpenTarget('explorer'),
            title: '在 Windows 资源管理器中打开这个 WSL 发行版',
          }, '文件') : null,
          target.kind === 'ssh' ? h(Button, { size: 'sm', variant: 'ghost', onClick: onEdit }, isConfig ? '查看配置' : '编辑') : null))
    }

    // ---------------------------------------------------------------------
    // Connect dialog
    // ---------------------------------------------------------------------
    function ConnectDialog ({ target, settings, busy, onClose, onConnect }) {
      const [path, setPath] = useState(target.home ?? '')
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [options, setOptions] = useState({
        syncPlugins: settings?.syncPlugins !== false,
        syncCredentials: settings?.syncCredentials !== false,
        syncSkills: settings?.syncSkills !== false,
        syncPrompts: settings?.syncPrompts !== false,
      })

      const load = useCallback(async (nextPath) => {
        setLoading(true)
        setError(null)
        try {
          const result = await listFolder(target.id, nextPath)
          setListing(result)
          setPath(result.path)
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        } finally {
          setLoading(false)
        }
      }, [target.id])

      useEffect(() => { void load(target.home ?? '') }, [load, target.home])

      const canConnect = listing !== null && !loading && !busy
      return h(Modal, {
        title: `连接到 ${target.name}`,
        subtitle: target.detail,
        onClose,
        wide: true,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose, disabled: busy }, '取消'),
          h(Button, {
            key: 'go', variant: 'primary', onClick: () => onConnect(listing?.path ?? path, options), disabled: !canConnect,
            icon: busy ? h(Spinner, null) : null,
          }, busy ? '正在连接…' : '连接并打开'),
        ],
      },
      h('div', { className: 'dre-note' }, '远端 dsh 会在这个目录里启动；首次连接会在远端安装 dsh 并同步配置。'),
      h('div', { className: 'dre-pathbar' },
        h('input', {
          className: 'dre-input',
          value: path,
          spellCheck: false,
          onChange: (event) => setPath(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') void load(path) },
          placeholder: '/home/user/project',
        }),
        h(Button, { size: 'sm', onClick: () => void load(path), disabled: loading }, '前往')),
      h('div', { className: 'dre-list' },
        loading
          ? h('div', { className: 'dre-list-empty' }, '正在读取远程目录…')
          : error !== null
            ? h('div', { className: 'dre-list-empty dre-danger' }, error)
            : listing === null
              ? h('div', { className: 'dre-list-empty' }, '没有目录')
              : [
                listing.parent === null ? null : h('div', {
                  key: '..',
                  className: 'dre-list-row',
                  onClick: () => void load(listing.parent),
                }, h('span', { className: 'dre-dim' }, '..'), h('span', { className: 'dre-list-name dre-dim' }, '上一级')),
                ...listing.entries.map(entry => h('div', {
                  key: entry.path,
                  className: 'dre-list-row',
                  onClick: () => void load(entry.path),
                },
                h(IconDisk, null),
                h('span', { className: 'dre-list-name' }, entry.name),
                h('span', { className: 'dre-dim', style: { marginLeft: 'auto', fontSize: '10.5px' } }, ''))),
                listing.entries.length === 0 ? h('div', { className: 'dre-list-empty' }, '空目录') : null,
                h('div', { className: 'dre-list-row', style: { cursor: 'default' } },
                  h('span', { className: 'dre-success' }, '✓'),
                  h('span', { className: 'dre-list-name dre-dim' }, `当前：${listing.path}`)),
              ]),
      h('div', { style: { display: 'grid', gap: '2px' } },
        h(Check, {
          checked: options.syncPlugins,
          onChange: value => setOptions(current => ({ ...current, syncPlugins: value })),
          title: '同步本地插件集',
          detail: '在远端安装与本地相同的插件依赖；失败时自动回退到基础插件集。首次较慢。',
        }),
        h(Check, {
          checked: options.syncCredentials,
          onChange: value => setOptions(current => ({ ...current, syncCredentials: value })),
          title: '同步模型凭据',
          detail: '复制 .credentials.yaml（含 API Key）；模型选择与 provider 配置随 cordis.patch.yml 一起同步。',
        }),
        h(Check, {
          checked: options.syncSkills,
          onChange: value => setOptions(current => ({ ...current, syncSkills: value })),
          title: '同步技能',
          detail: '复制 ~/.agents/skills 与 ~/.dsh/skills。',
        }),
        h(Check, {
          checked: options.syncPrompts,
          onChange: value => setOptions(current => ({ ...current, syncPrompts: value })),
          title: '同步提示词',
          detail: '复制 AGENTS.md 等全局指令文件。',
        })))
    }

    // ---------------------------------------------------------------------
    // Host editor
    // ---------------------------------------------------------------------
    function HostDialog ({ target, onClose, onSaved, onDeleted }) {
      const editing = target !== undefined
      const readOnly = editing && target.source === 'ssh-config'
      const [alias, setAlias] = useState(target?.alias ?? target?.name ?? '')
      const [host, setHost] = useState(target?.host ?? '')
      const [port, setPort] = useState(String(target?.port ?? 22))
      const [user, setUser] = useState(target?.user ?? '')
      const [kind, setKind] = useState(target?.auth ?? 'key')
      const [keyPath, setKeyPath] = useState(target?.keyPath ?? '')
      const [agentPath, setAgentPath] = useState(target?.agentPath ?? '')
      const [password, setPassword] = useState('')
      const [passphrase, setPassphrase] = useState('')
      const [description, setDescription] = useState(target?.description ?? '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [confirmDelete, setConfirmDelete] = useState(false)

      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          await saveHost({
            originalAlias: editing ? target.alias : undefined,
            alias,
            host,
            port: Number.parseInt(port, 10),
            user,
            auth: { kind, keyPath, agentPath, password, passphrase },
            description,
          })
          onSaved()
        } catch (submitError) {
          setError(submitError instanceof Error ? submitError.message : String(submitError))
        } finally {
          setBusy(false)
        }
      }

      const remove = async () => {
        if (!confirmDelete) { setConfirmDelete(true); return }
        setBusy(true)
        setError(null)
        try {
          await deleteHost(target.alias)
          onDeleted()
        } catch (deleteError) {
          setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: editing ? (readOnly ? '主机配置（只读）' : `编辑主机 ${target.alias}`) : '添加 SSH 主机',
        subtitle: readOnly ? '该主机来自 ~/.ssh/config；请直接编辑那个文件。' : '主机记录写入 $DSH_HOME/dsh-ssh.json，与「远程工作区」面板共享。',
        onClose,
        footer: [
          readOnly ? null : h(Button, { key: 'delete', variant: 'danger', onClick: () => void remove(), disabled: busy }, confirmDelete ? '确认删除' : '删除'),
          h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose, disabled: busy }, '取消'),
          readOnly ? null : h(Button, { key: 'save', variant: 'primary', onClick: () => void submit(), disabled: busy }, busy ? '保存中…' : '保存'),
        ].filter(Boolean),
      },
      error === null ? null : h('div', { className: 'dre-error-box' }, h('div', null, h('strong', null, '保存失败：'), error)),
      h('div', { className: 'dre-row' },
        h(Field, { label: '别名' }, h('input', { className: 'dre-input', value: alias, disabled: readOnly, onChange: e => setAlias(e.target.value), placeholder: 'myserver' })),
        h(Field, { label: '主机地址' }, h('input', { className: 'dre-input', value: host, disabled: readOnly, onChange: e => setHost(e.target.value), placeholder: 'host.example.com' }))),
      h('div', { className: 'dre-row' },
        h(Field, { label: '端口' }, h('input', { className: 'dre-input', value: port, disabled: readOnly, onChange: e => setPort(e.target.value), inputMode: 'numeric' })),
        h(Field, { label: '用户名' }, h('input', { className: 'dre-input', value: user, disabled: readOnly, onChange: e => setUser(e.target.value), placeholder: 'root' }))),
      h(Field, { label: '认证方式' },
        h('select', { className: 'dre-select', value: kind, disabled: readOnly, onChange: e => setKind(e.target.value) },
          h('option', { value: 'key' }, '私钥文件'),
          h('option', { value: 'password' }, '密码'),
          h('option', { value: 'agent' }, 'SSH Agent'))),
      kind === 'key' ? h(Field, { label: '私钥路径', hint: '例如 ~/.ssh/id_ed25519；口令可留空' },
        h('input', { className: 'dre-input', value: keyPath, disabled: readOnly, onChange: e => setKeyPath(e.target.value), placeholder: '~/.ssh/id_ed25519' })) : null,
      kind === 'password' ? h(Field, { label: editing ? '密码（留空保持原值）' : '密码' },
        h('input', { className: 'dre-input', type: 'password', value: password, disabled: readOnly, onChange: e => setPassword(e.target.value), autoComplete: 'new-password' })) : null,
      kind === 'agent' ? h(Field, { label: 'Agent 地址（可选）', hint: '留空使用 SSH_AUTH_SOCK / Pageant' },
        h('input', { className: 'dre-input', value: agentPath, disabled: readOnly, onChange: e => setAgentPath(e.target.value), placeholder: 'C:\\\\path\\\\to\\\\agent.sock' })) : null,
      kind === 'key' ? h(Field, { label: '私钥口令（可选）', hint: editing ? '留空保持原值' : '仅本机加密保存' },
        h('input', { className: 'dre-input', type: 'password', value: passphrase, disabled: readOnly, onChange: e => setPassphrase(e.target.value), autoComplete: 'new-password' })) : null,
      h(Field, { label: '备注（可选）' }, h('input', { className: 'dre-input', value: description, disabled: readOnly, onChange: e => setDescription(e.target.value) })))
    }

    // ---------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------
    function SettingsDialog ({ settings, local, onClose, onSaved }) {
      const [form, setForm] = useState({
        syncPlugins: settings?.syncPlugins !== false,
        syncCredentials: settings?.syncCredentials !== false,
        syncSkills: settings?.syncSkills !== false,
        syncPrompts: settings?.syncPrompts !== false,
        npmRegistry: settings?.npmRegistry ?? '',
        dshVersion: settings?.dshVersion ?? 'auto',
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          await saveSettings(form)
          onSaved()
        } catch (submitError) {
          setError(submitError instanceof Error ? submitError.message : String(submitError))
        } finally {
          setBusy(false)
        }
      }
      return h(Modal, {
        title: '远程资源管理器设置',
        subtitle: '这些选项会成为新建连接的默认值。',
        onClose,
        footer: [
          h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose, disabled: busy }, '取消'),
          h(Button, { key: 'save', variant: 'primary', onClick: () => void submit(), disabled: busy }, busy ? '保存中…' : '保存'),
        ],
      },
      error === null ? null : h('div', { className: 'dre-error-box' }, error),
      h(Check, { checked: form.syncPlugins, onChange: value => setForm(f => ({ ...f, syncPlugins: value })), title: '默认同步本地插件集', detail: '远端 profile 安装本地 package.json 中的插件；失败自动回退基础插件集。' }),
      h(Check, { checked: form.syncCredentials, onChange: value => setForm(f => ({ ...f, syncCredentials: value })), title: '默认同步模型凭据', detail: '复制 .credentials.yaml（API Key）到远端 ~/.dsh，权限 600。' }),
      h(Check, { checked: form.syncSkills, onChange: value => setForm(f => ({ ...f, syncSkills: value })), title: '默认同步技能', detail: '复制 ~/.agents/skills 与 ~/.dsh/skills。' }),
      h(Check, { checked: form.syncPrompts, onChange: value => setForm(f => ({ ...f, syncPrompts: value })), title: '默认同步提示词', detail: '复制全局 AGENTS.md。' }),
      h(Field, { label: 'npm registry（可选）', hint: '留空使用远端 npm 默认源；国内可填 https://registry.npmmirror.com' },
        h('input', { className: 'dre-input', value: form.npmRegistry, onChange: e => setForm(f => ({ ...f, npmRegistry: e.target.value })), placeholder: 'https://registry.npmmirror.com', spellCheck: false })),
      h(Field, { label: '远端 dsh 版本', hint: `auto 会使用本地版本${local?.version ? `（${local.version}）` : ''}` },
        h('input', { className: 'dre-input', value: form.dshVersion, onChange: e => setForm(f => ({ ...f, dshVersion: e.target.value })), placeholder: 'auto' })),
      h('div', { className: 'dre-note' }, local?.node ? `本地 Node.js：${local.node}` : ''))
    }

    // ---------------------------------------------------------------------
    // Connection view
    // ---------------------------------------------------------------------
    function ConnectionBody ({ connection, showLog, onDisconnect, onRetry }) {
      const [log, setLog] = useState('')
      const logRef = useRef(null)
      const logVisible = showLog || connection.state !== 'ready'

      useEffect(() => {
        setLog('')
      }, [connection.id])

      useEffect(() => {
        if (!logVisible) return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const value = await loadLog(connection.id)
            if (!cancelled) setLog(value)
          } catch { /* the connection may have disappeared */ }
        }
        void tick()
        const timer = window.setInterval(() => { void tick() }, 1200)
        return () => { cancelled = true; window.clearInterval(timer) }
      }, [connection.id, logVisible])

      useEffect(() => {
        const element = logRef.current
        if (element === null || !logVisible) return
        element.scrollTop = element.scrollHeight
      }, [log, logVisible])

      const copyLog = async () => {
        try {
          await navigator.clipboard.writeText(log)
        } catch { /* clipboard permission is host-controlled */ }
      }

      const logPanel = logVisible
        ? h(React.Fragment, null,
          h('div', { className: 'dre-log-head' },
            h('span', { className: 'dre-log-title' }, '连接日志'),
            h('span', { className: 'dre-log-hint' }, 'token 已脱敏 · 自动刷新'),
            h('span', { className: 'dre-grow' }),
            h(Button, { size: 'sm', variant: 'ghost', onClick: () => void copyLog(), disabled: log === '' }, '复制')),
          h('div', { className: 'dre-log', ref: logRef }, log || '（暂无日志）'))
        : null

      if (connection.state === 'ready') {
        return h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          showLog ? logPanel : null,
          h('div', { className: 'dre-iframe-wrap' },
            h('iframe', {
              className: 'dre-iframe',
              src: connection.url,
              title: `远程 dsh · ${connection.targetName}`,
              allow: 'clipboard-read; clipboard-write; fullscreen',
              referrerPolicy: 'no-referrer',
            })))
      }
      return h('div', { className: 'dre-body', style: { overflow: 'auto' } },
        h('div', { className: 'dre-progress' },
          h('div', { className: 'dre-progress-head' },
            connection.state === 'working' ? h(Spinner, null) : h('span', { className: 'dre-danger', style: { fontSize: '16px' } }, '!'),
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, connection.state === 'working' ? '正在准备远端环境…' : '连接失败'),
              h('div', { className: 'dre-dim', style: { fontSize: '11.5px' } },
                connection.state === 'working'
                  ? '首次连接会安装远端 dsh 并同步配置，可能需要一两分钟。'
                  : (connection.error ?? '未知错误')))),
          connection.state === 'error' ? h('div', { className: 'dre-error-box', style: { marginBottom: '14px' } },
            h('div', null,
              h('strong', null, '错误：'),
              connection.error ?? '未知错误',
              h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' } },
                h(Button, { size: 'sm', onClick: onRetry }, '返回目标列表'),
                h(Button, { size: 'sm', variant: 'ghost', onClick: onDisconnect }, '清理连接')))) : null,
          connection.steps.length === 0 ? null : h('div', { className: 'dre-steps' }, connection.steps.map(step => h('div', { className: 'dre-step', key: step.key },
            h('span', { className: cls('dre-step-icon', step.state) }, step.state === 'done' ? '✓' : step.state === 'error' ? '!' : step.state === 'running' ? '·' : ''),
            h('div', { className: 'dre-step-main' },
              h('div', { className: 'dre-step-label' }, step.label),
              step.detail ? h('div', { className: 'dre-step-detail' }, step.detail) : null)))),
          connection.syncReport === undefined ? null : h('div', { className: 'dre-report' },
            h(Badge, { tone: connection.syncReport.mode === 'full' ? 'ok' : 'warn' }, connection.syncReport.mode === 'full' ? '完整插件集' : '基础插件集'),
            connection.syncReport.credentials ? h(Badge, { tone: 'ok' }, '凭据已同步') : h(Badge, null, '未同步凭据'),
            connection.syncReport.skills ? h(Badge, null, `技能 ${connection.syncReport.copiedFiles} 文件`) : null,
            connection.syncReport.prompts ? h(Badge, null, '提示词已同步') : null,
            ...(connection.syncReport.warnings ?? []).map((warning, index) => h(Badge, { key: `w${index}`, tone: 'warn' }, warning))),
          logPanel))
    }

    // ---------------------------------------------------------------------
    // Remote workspace status (sidebar row badge + hover card)
    // ---------------------------------------------------------------------
    /** One-line state labels for the workspace badge and card pill. */
    const WS_STATE_TEXT = {
      checking: '连接中',
      connected: '已连接',
      hot: '已连接',
      failed: '连接失败',
      disabled: '已停用',
      unknown: '待检查',
    }

    function wsClock (at) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function wsEscape (value) {
      return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character])
    }

    /**
     * Watch `ssh://` workspaces and dress their sidebar rows with a live
     * status dot plus a hover card carrying the same fields a remote explorer
     * shows: device, connection, address, directory, and the probe log.
     *
     * The DSH workspace row is rendered by the host's sidebar (or by the
     * codex-ui plugin when it takes over), and neither exposes the workspace
     * path as a data attribute. Rows are matched by title, which is unique for
     * practical purposes; a workspace without a row simply stays unstyled.
     *
     * @returns {() => void} disposer.
     */
    function installRemoteWorkspaceStatus () {
      if (typeof document === 'undefined') return () => {}
      const store = {
        workspaces: [],
        byPath: new Map(),
        byTitle: new Map(),
        disabled: new Set(),
        connections: new Map(),
      }
      const probing = new Set()
      let refreshTimer
      let badgeTimer
      let autoTimer
      let firstTimer
      let cardEl
      let cardPath
      let cardRow
      let cardHideTimer
      let disposed = false

      const ROW_SELECTOR = '.dcu-wb-project-head, [class*="_projectRow"]'

      /**
       * `[class*="_projectRow"]` also matches descendants such as
       * `_projectRowTitle`; only the element whose own class token ends in
       * `_projectRow` (DSH's hashed class names) or the codex-ui project head
       * is a real row.
       */
      function isProjectRow (element) {
        if (!(element instanceof Element)) return false
        if (element.classList.contains('dcu-wb-project-head')) return true
        for (const token of element.classList) {
          if (/_projectRow$/u.test(token)) return true
        }
        return false
      }

      function projectRows () {
        const rows = []
        for (const element of document.querySelectorAll(ROW_SELECTOR)) {
          if (isProjectRow(element)) rows.push(element)
        }
        return rows
      }

      /** Nearest enclosing project row for an event target. */
      function rowFor (node) {
        let element = node instanceof Element ? node : null
        while (element !== null && element !== document.body) {
          if (isProjectRow(element)) return element
          element = element.parentElement
        }
        return null
      }

      function titleElement (row) {
        const direct = row.querySelector('.dcu-wb-project-title')
        if (direct !== null) return direct
        for (const candidate of row.querySelectorAll('[class*="title" i]')) {
          if (candidate.children.length === 0 && (candidate.textContent ?? '').trim() !== '') return candidate
        }
        return null
      }

      function workspaceForTitle (title) {
        if (title === '') return undefined
        const exact = store.byTitle.get(title)
        if (exact !== undefined) return exact
        return store.workspaces.find(workspace => workspace.title === title)
      }

      function workspaceForRow (row) {
        const title = titleElement(row)?.textContent?.trim() ?? ''
        return workspaceForTitle(title)
      }

      function effectiveState (workspace) {
        if (store.disabled.has(workspace.path)) return 'disabled'
        if (workspace.state === 'checking') return 'checking'
        if (workspace.state === 'failed') return 'failed'
        if (workspace.state === 'connected') {
          const connection = store.connections.get(workspace.alias)
          return connection?.state === 'connected' ? 'hot' : 'connected'
        }
        return 'unknown'
      }

      function stateText (state) {
        return WS_STATE_TEXT[state] ?? state
      }

      function refreshBadges () {
        if (disposed) return
        for (const row of projectRows()) {
          const titleElementNode = titleElement(row)
          const workspace = titleElementNode === null ? undefined : workspaceForRow(row)
          // DSH wraps the title in a vertical `projectText` block; inserting
          // next to the title there stacks badges into a column. Anchor the
          // badge to the row's own child block instead, so it sits on the
          // horizontal row after the title (or after the whole text block).
          let anchor = titleElementNode
          while (anchor !== null && anchor.parentElement !== row) anchor = anchor.parentElement
          let badge = anchor?.nextElementSibling
          if (badge === null || badge === undefined || !badge.classList.contains('dre-ws-badge')) badge = null
          for (const stray of row.querySelectorAll('.dre-ws-badge')) {
            if (stray !== badge) stray.remove()
          }
          if (workspace === undefined || titleElementNode === null || anchor === null) {
            badge?.remove()
            continue
          }
          if (badge === null) {
            badge = document.createElement('span')
            badge.className = 'dre-ws-badge'
            badge.setAttribute('aria-hidden', 'true')
            anchor.after(badge)
          }
          const state = effectiveState(workspace)
          if (badge.dataset.state !== state) badge.dataset.state = state
          const label = `${workspace.title} · ${stateText(state)}`
          if (badge.title !== label) badge.title = label
        }
      }

      function cardHtml (workspace) {
        const state = effectiveState(workspace)
        const device = workspace.device !== '' ? workspace.device : (state === 'checking' ? '检测中…' : '—')
        const address = workspace.address !== '' ? workspace.address : (workspace.alias !== '' ? workspace.alias : '—')
        const directory = workspace.directory !== '' ? workspace.directory : workspace.path
        const auth = workspace.authKind === 'key'
          ? 'SSH · 密钥'
          : workspace.authKind === 'password' ? 'SSH · 密码' : workspace.authKind === 'agent' ? 'SSH · Agent' : 'SSH'
        const rows = [
          ['项目名称', workspace.title, false],
          ['设备', device, false],
          ['连接', auth, false],
          ['地址', address, true],
          ['目录', directory, true],
        ]
        const logLines = (Array.isArray(workspace.log) ? workspace.log : []).slice(-40).map((entry) => {
          const level = entry.level === 'ok' ? 'ok' : entry.level === 'err' ? 'err' : 'info'
          return `<div class="dre-ws-log-line" data-level="${level}"><span class="dre-ws-log-time">${wsClock(entry.at)}</span><span class="dre-ws-log-text">${wsEscape(entry.text)}</span></div>`
        }).join('')
        const log = logLines === ''
          ? `<div class="dre-ws-log-empty">${state === 'disabled' ? '工作区已停用，未检查' : '还没有检查记录'}</div>`
          : `<div class="dre-ws-log-lines">${logLines}</div>`
        const foot = state === 'disabled'
          ? '工作区已停用'
          : state === 'checking'
            ? '正在连接…'
            : workspace.checkedAt > 0
              ? `检查于 ${wsClock(workspace.checkedAt)} · ${Math.max(1, Math.round(workspace.durationMs || 0))}ms`
              : '鼠标停留时自动检查'
        const spinner = state === 'checking' ? '<span class="dre-ws-pill-spinner"></span>' : ''
        return [
          '<div class="dre-ws-card-head">',
          '<span class="dre-ws-card-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 3.6h4l1.3 1.5h7.7v7.3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg></span>',
          `<span class="dre-ws-card-title" title="${wsEscape(workspace.title)}">${wsEscape(workspace.title)}</span>`,
          `<span class="dre-ws-pill" data-state="${state}">${spinner}${stateText(state)}</span>`,
          '</div>',
          '<div class="dre-ws-card-rows">',
          ...rows.map(([label, value, mono]) => `<div class="dre-ws-row"><span class="dre-ws-row-label">${label}</span><span class="dre-ws-row-value${mono ? ' dre-ws-mono' : ''}" title="${wsEscape(value)}">${wsEscape(value)}</span></div>`),
          '</div>',
          '<div class="dre-ws-log"><div class="dre-ws-log-title">连接日志</div>',
          log,
          '</div>',
          `<div class="dre-ws-card-foot"><span>${foot}</span><span>${wsEscape(workspace.alias)}</span></div>`,
        ].join('')
      }

      function positionCard () {
        if (cardEl === undefined || cardRow === undefined) return
        const rect = cardRow.getBoundingClientRect()
        const width = cardEl.offsetWidth || 360
        const height = cardEl.offsetHeight || 220
        let left = rect.right + 10
        if (left + width > window.innerWidth - 8) left = rect.left - width - 10
        if (left < 8) left = 8
        let top = rect.top - 4
        if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8
        if (top < 8) top = 8
        cardEl.style.left = `${Math.round(left)}px`
        cardEl.style.top = `${Math.round(top)}px`
      }

      function renderCard (workspace) {
        if (cardEl === undefined) return
        cardEl.innerHTML = cardHtml(workspace)
        positionCard()
      }

      function ensureProbe (workspace) {
        if (disposed || probing.has(workspace.path)) return
        if (store.disabled.has(workspace.path)) return
        if (workspace.state === 'checking') return
        if (probing.size >= 2) return
        probing.add(workspace.path)
        workspace.state = 'checking'
        workspace.error = ''
        refreshBadges()
        if (cardPath === workspace.path) renderCard(workspace)
        fetchJson(API.remoteWorkspacesProbe, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: workspace.path }),
        })
          .then(({ workspace: fresh }) => {
            if (fresh === undefined) return
            const existing = store.byPath.get(fresh.path)
            if (existing !== undefined) Object.assign(existing, fresh)
            else {
              store.workspaces.push(fresh)
              store.byPath.set(fresh.path, fresh)
              if (!store.byTitle.has(fresh.title)) store.byTitle.set(fresh.title, fresh)
            }
            refreshBadges()
            if (cardPath === fresh.path) renderCard(fresh)
          })
          .catch((error) => {
            workspace.state = 'failed'
            workspace.error = error instanceof Error ? error.message : String(error)
            workspace.checkedAt = Date.now()
            refreshBadges()
            if (cardPath === workspace.path) renderCard(workspace)
          })
          .finally(() => {
            probing.delete(workspace.path)
            if (cardPath === workspace.path) renderCard(store.byPath.get(workspace.path) ?? workspace)
          })
      }

      function showCard (workspace, row) {
        cardPath = workspace.path
        cardRow = row
        if (cardEl === undefined) {
          cardEl = document.createElement('div')
          cardEl.className = 'dre-ws-card'
          cardEl.addEventListener('mouseenter', () => { clearTimeout(cardHideTimer) })
          cardEl.addEventListener('mouseleave', () => { cardHideTimer = window.setTimeout(hideCard, 140) })
          document.body.append(cardEl)
        }
        document.body.classList.add('dre-ws-card-open')
        renderCard(workspace)
        positionCard()
        clearTimeout(cardHideTimer)
        const state = effectiveState(workspace)
        if (state === 'unknown' || (state !== 'checking' && Date.now() - (workspace.checkedAt || 0) > 30_000)) {
          ensureProbe(workspace)
        }
      }

      function hideCard () {
        clearTimeout(cardHideTimer)
        cardPath = undefined
        cardRow = undefined
        cardEl?.remove()
        cardEl = undefined
        document.body.classList.remove('dre-ws-card-open')
      }

      function onPointerOver (event) {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = rowFor(target)
        if (row === null) return
        const workspace = workspaceForRow(row)
        if (workspace === undefined) return
        if (cardPath === workspace.path && cardRow === row) return
        showCard(workspace, row)
      }

      function onPointerOut (event) {
        if (cardRow === undefined) return
        const next = event.relatedTarget
        if (next instanceof Node && (cardRow.contains(next) || cardEl?.contains(next))) return
        cardHideTimer = window.setTimeout(hideCard, 160)
      }

      function onRowClick (event) {
        const target = event.target
        if (!(target instanceof Element) || target.closest('button') !== null) return
        const row = rowFor(target)
        if (row === null) return
        const workspace = workspaceForRow(row)
        if (workspace === undefined) return
        if (effectiveState(workspace) === 'checking') return
        if (Date.now() - (workspace.checkedAt || 0) < 30_000) return
        ensureProbe(workspace)
      }

      function onViewportChange () {
        if (cardPath !== undefined) positionCard()
      }

      async function refresh () {
        if (disposed || document.visibilityState === 'hidden') return
        try {
          const [list, ssh] = await Promise.all([
            fetchJson(API.remoteWorkspaces).catch(() => ({ workspaces: [] })),
            fetchJson(API.sshStatus).catch(() => ({})),
          ])
          store.disabled = new Set(Array.isArray(ssh.disabled) ? ssh.disabled : [])
          store.connections = new Map((Array.isArray(ssh.connections) ? ssh.connections : []).map(connection => [String(connection.alias), connection]))
          store.workspaces = Array.isArray(list.workspaces) ? list.workspaces : []
          store.byPath = new Map(store.workspaces.map(workspace => [workspace.path, workspace]))
          store.byTitle = new Map()
          for (const workspace of store.workspaces) {
            if (!store.byTitle.has(workspace.title)) store.byTitle.set(workspace.title, workspace)
          }
          if (cardPath !== undefined) {
            const fresh = store.byPath.get(cardPath)
            if (fresh === undefined) hideCard()
            else renderCard(fresh)
          }
          refreshBadges()
        } catch { /* transient; the next poll retries */ }
      }

      function autoProbe () {
        if (disposed || document.visibilityState === 'hidden') return
        const now = Date.now()
        const due = store.workspaces.filter((workspace) => {
          if (store.disabled.has(workspace.path)) return false
          if (workspace.state === 'checking' || probing.has(workspace.path)) return false
          return workspace.checkedAt === 0 || now - workspace.checkedAt > 45_000
        })
        for (const workspace of due.slice(0, 2)) ensureProbe(workspace)
      }

      document.addEventListener('mouseover', onPointerOver, true)
      document.addEventListener('mouseout', onPointerOut, true)
      document.addEventListener('click', onRowClick, true)
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('resize', onViewportChange)

      void refresh()
      refreshTimer = window.setInterval(() => { void refresh() }, 3000)
      badgeTimer = window.setInterval(refreshBadges, 1000)
      autoTimer = window.setInterval(autoProbe, 5000)
      firstTimer = window.setTimeout(autoProbe, 1500)

      return () => {
        disposed = true
        window.clearInterval(refreshTimer)
        window.clearInterval(badgeTimer)
        window.clearInterval(autoTimer)
        window.clearTimeout(firstTimer)
        document.removeEventListener('mouseover', onPointerOver, true)
        document.removeEventListener('mouseout', onPointerOut, true)
        document.removeEventListener('click', onRowClick, true)
        window.removeEventListener('scroll', onViewportChange, true)
        window.removeEventListener('resize', onViewportChange)
        hideCard()
      }
    }

    // ---------------------------------------------------------------------
    // Plugin apply
    // ---------------------------------------------------------------------
    const inject = ['slots']

    function apply (ctx) {
      const disposeStyles = installStyles()
      const disposeWorkspaceStatus = installRemoteWorkspaceStatus()
      const slots = ctx.slots

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 46,
        label: () => '远程资源管理器',
      }, IconRemote))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
      }, ExplorerPage))

      return () => {
        disposeStyles()
        disposeWorkspaceStatus()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})










