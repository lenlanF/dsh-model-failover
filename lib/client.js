window.__ModuleLoader__.load({
  id: "dsh-model-failover",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;
    const NS = "dsh-model-failover";
    const SECTION_ID = "dsh-model-failover";
    const CONFIG_PATH = "/plugins/dsh-model-failover/config";
    const RESTORE_PATH = "/plugins/dsh-model-failover/restore";
    const DEFAULT_TRIGGERS = ["QUOTA", "ACCOUNT_QUOTA", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED"];
    const ALL_TRIGGERS = [...DEFAULT_TRIGGERS];
    const MODES = [
      { id: "off", label: "关闭（正常）", hint: "按你选择的模型正常使用；故障时按整条降级链切换。" },
      { id: "pinned", label: "仅用降级链", hint: "只使用降级链内的模型：会话被锁定在链内，链外模型不可选；故障时按链降级。" },
      { id: "free", label: "仅免费额度", hint: "只使用降级链中标记为「免费」的模型；这些档位全部耗尽即停止，不会回退到消耗积分的模型。" },
    ];

    const C = {
      accent: "#4c8dff", accentSoft: "rgba(76,141,255,.12)", accentBorder: "rgba(76,141,255,.38)",
      ok: "#2fa36b", warn: "#d98b2b", danger: "#e05c58",
      border: "rgba(128,128,128,.20)", borderStrong: "rgba(128,128,128,.34)",
      surface: "rgba(128,128,128,.055)", surface2: "rgba(128,128,128,.10)",
      muted: "rgba(128,128,128,.78)",
    };
    const s = {
      wrap: { padding: "20px 26px 110px", color: "var(--text, inherit)", maxWidth: "1040px", fontSize: "13px" },
      header: { display: "flex", alignItems: "flex-start", gap: "14px", marginBottom: "18px" },
      badge: { width: 40, height: 40, borderRadius: 12, background: C.accentSoft, border: "1px solid " + C.accentBorder, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 },
      title: { fontSize: 18, fontWeight: 700, margin: "0 0 5px", letterSpacing: ".2px" },
      subtitle: { fontSize: 12, lineHeight: 1.65, opacity: .7, margin: 0 },
      card: { border: "1px solid " + C.border, borderRadius: 12, background: C.surface, padding: "16px 18px", marginBottom: 14 },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 },
      cardTitle: { fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 },
      step: { width: 20, height: 20, borderRadius: 6, background: C.accentSoft, color: C.accent, fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" },
      hint: { fontSize: 11, opacity: .62, lineHeight: 1.6, margin: "10px 0 0" },
      row: { display: "flex", alignItems: "center", gap: 10 },
      panel: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12 },
      field: { display: "flex", flexDirection: "column", gap: 5 },
      fieldLabel: { fontSize: 11, opacity: .72 },
      input: { width: "100%", boxSizing: "border-box", padding: "7px 9px", border: "1px solid " + C.borderStrong, background: "transparent", color: "inherit", borderRadius: 8, fontSize: 12 },
      search: { width: "100%", boxSizing: "border-box", padding: "8px 11px", border: "1px solid " + C.borderStrong, background: "transparent", color: "inherit", borderRadius: 9, fontSize: 12, marginBottom: 10 },
      btn: { cursor: "pointer", border: "1px solid " + C.borderStrong, background: "transparent", color: "inherit", borderRadius: 8, padding: "5px 11px", fontSize: 11, transition: "background .15s" },
      btnSmall: { cursor: "pointer", border: "1px solid " + C.border, background: "transparent", color: "inherit", borderRadius: 6, width: 26, height: 26, fontSize: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" },
      primary: { cursor: "pointer", border: "none", borderRadius: 9, padding: "9px 20px", fontSize: 13, fontWeight: 700, background: C.accent, color: "#fff", boxShadow: "0 4px 14px rgba(76,141,255,.28)" },
      chainRow: { display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", border: "1px solid " + C.accentBorder, background: C.accentSoft, borderRadius: 9, marginBottom: 7 },
      num: { width: 22, height: 22, borderRadius: "50%", background: C.accent, color: "#fff", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
      mono: { fontFamily: "ui-monospace,Menlo,Consolas,monospace", fontSize: 11 },
      tag: { fontSize: 10, padding: "2px 7px", borderRadius: 5, background: C.surface2, whiteSpace: "nowrap" },
      tagOn: { fontSize: 10, padding: "2px 7px", borderRadius: 5, background: "rgba(47,163,107,.16)", color: C.ok, whiteSpace: "nowrap" },
      modelRow: { display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid transparent" },
      groupHead: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 4px", cursor: "pointer", background: "transparent", border: "none", color: "inherit", textAlign: "left", fontSize: 12, fontWeight: 600 },
      chip: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, border: "1px solid " + C.border, cursor: "pointer", fontSize: 11 },
      chipOn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, border: "1px solid " + C.accentBorder, background: C.accentSoft, cursor: "pointer", fontSize: 11 },
      notice: { fontSize: 11.5, lineHeight: 1.6, padding: "9px 12px", borderRadius: 8, marginTop: 10 },
      logRow: { display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px dashed " + C.border, fontSize: 11 },
      footer: { position: "sticky", bottom: 0, marginTop: 8, padding: "12px 0", display: "flex", alignItems: "center", gap: 12, background: "linear-gradient(to top, var(--bg, rgba(24,24,28,.97)) 72%, transparent)", zIndex: 2 },
      skeleton: { height: 12, borderRadius: 6, background: C.surface2, marginBottom: 8 },
    };

    function Switch({ checked, onChange, label, hint }) {
      return h("label", { style: { ...s.row, cursor: "pointer", justifyContent: "space-between", padding: "4px 0" } },
        h("span", null, h("div", { style: { fontSize: 12, fontWeight: 600 } }, label), hint ? h("div", { style: { fontSize: 10.5, opacity: .62 } }, hint) : null),
        h("span", { style: { width: 38, height: 22, borderRadius: 999, background: checked ? C.accent : C.surface2, border: "1px solid " + (checked ? C.accentBorder : C.borderStrong), position: "relative", flexShrink: 0, transition: "background .18s" } },
          h("span", { style: { position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .18s" } })),
        h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked), style: { display: "none" } }));
    }

    function Field({ label, value, onChange, min, step, suffix }) {
      return h("div", { style: s.field },
        h("span", { style: s.fieldLabel }, label),
        h("div", { style: { ...s.row, gap: 6 } },
          h("input", { style: s.input, type: "number", min, step, value, onFocus: (e) => e.target.select(), onChange: (e) => onChange(e.target.value) }),
          suffix ? h("span", { style: { fontSize: 11, opacity: .6, whiteSpace: "nowrap" } }, suffix) : null));
    }

    function Card(props) {
      const ctx = props.ctx || props.api?.ctx;
      const [rules, setRules] = useState(null);
      const [saved, setSaved] = useState(null);
      const [catalog, setCatalog] = useState([]);
      const [catalogError, setCatalogError] = useState("");
      const [busy, setBusy] = useState(false);
      const [restoreAgents, setRestoreAgents] = useState([]);
      const [restoreAgentId, setRestoreAgentId] = useState('');
      const [message, setMessage] = useState({ kind: "", text: "" });
      const [query, setQuery] = useState("");
      const [collapsed, setCollapsed] = useState({});
      const [dragIndex, setDragIndex] = useState(null);
      const [showAll, setShowAll] = useState(false);
      const dirtyRef = useRef(false);

      const normalize = useCallback((data) => ({
        enabled: data.enabled !== false,
        mode: data.mode === "pinned" || data.mode === "free" ? data.mode : "off",
        exhausted: data.exhausted === true,
        priority: (data.priority || []).map((x) => ({ provider: x.provider, model: x.model,
          ...(x.reasoningEffort ? { reasoningEffort: x.reasoningEffort } : {}), ...(x.free === true ? { free: true } : {}) })),
        triggers: data.triggers || [...DEFAULT_TRIGGERS],
        maxSwitchesPerSession: data.maxSwitchesPerSession ?? 3,
        cooldownMs: data.cooldownMs ?? 0,
        switchLogLimit: data.switchLogLimit ?? 20,
        switchLog: data.switchLog || [],
      }), []);

      const loadConfig = useCallback(async () => {
        try {
          const res = await fetch(CONFIG_PATH);
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "config read failed");
          const next = normalize(data.rules);
          setRules(next); setSaved(next); dirtyRef.current = false;
        } catch (error) { setMessage({ kind: "error", text: "读取规则失败：" + String(error.message || error) }); }
      }, [normalize]);

      const loadCatalog = useCallback(async () => {
        try {
          const remote = ctx?.remote?.session;
          if (!remote?.modelCatalog) throw new Error("session.modelCatalog 不可用");
          const response = await remote.modelCatalog();
          if (!response.ok) throw new Error(response.error?.message || "modelCatalog refused");
          setCatalog((response.value.groups || []).map((g) => ({
            id: g.id, name: g.name || g.id,
            models: (g.models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
          })));
          setCatalogError("");
        } catch (error) { setCatalogError("模型目录读取失败：" + String(error.message || error)); }
      }, [ctx]);

      useEffect(() => { loadConfig(); loadCatalog();
        fetch(RESTORE_PATH).then(r => r.json()).then(data => {
          if (data.ok && Array.isArray(data.agents)) setRestoreAgents(data.agents);
        }).catch(() => {});
      }, [loadConfig, loadCatalog]);
      useEffect(() => {
        if (!dirtyRef.current) return;
        const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
      });

      const allModels = useMemo(() => catalog.flatMap((g) => g.models.map((m) => ({ ...m, provider: g.id, providerName: g.name }))), [catalog]);
      const chainKeys = useMemo(() => new Set((rules?.priority || []).map((x) => x.provider + "/" + x.model)), [rules]);
      const crossProvider = useMemo(() => new Set((rules?.priority || []).map((x) => x.provider)).size > 1, [rules]);
      const dirty = useMemo(() => {
        if (!rules || !saved) return false;
        return JSON.stringify({ ...rules, switchLog: [] }) !== JSON.stringify({ ...saved, switchLog: [] });
      }, [rules, saved]);
      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return catalog;
        return catalog.map((g) => ({ ...g, models: g.models.filter((m) =>
          (m.name + " " + m.id + " " + g.name + " " + g.id).toLowerCase().includes(q)) })).filter((g) => g.models.length > 0);
      }, [catalog, query]);

      const patch = (next) => { dirtyRef.current = true; setRules((old) => ({ ...old, ...next })); };
      const toggle = (entry) => {
        const key = entry.provider + "/" + entry.model;
        const priority = rules.priority.filter((x) => x.provider + "/" + x.model !== key);
        if (!chainKeys.has(key)) priority.push({ provider: entry.provider, model: entry.model });
        patch({ priority });
      };
      const move = (index, delta) => {
        const priority = [...rules.priority];
        const target = index + delta;
        if (target < 0 || target >= priority.length) return;
        [priority[index], priority[target]] = [priority[target], priority[index]];
        patch({ priority });
      };
      const toggleTrigger = (code) => patch({ triggers: rules.triggers.includes(code)
        ? rules.triggers.filter((c) => c !== code) : [...rules.triggers, code] });

      const save = async () => {
        if (!dirty || busy) return;
        setBusy(true); setMessage({ kind: "", text: "" });
        try {
          const payload = {
            enabled: rules.enabled,
            mode: rules.mode,
            priority: rules.priority,
            triggers: rules.triggers,
            maxSwitchesPerSession: Number(rules.maxSwitchesPerSession),
            cooldownMs: Number(rules.cooldownMs),
            switchLogLimit: Number(rules.switchLogLimit),
          };
          const res = await fetch(CONFIG_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "save failed");
          setMessage({ kind: "ok", text: "✓ 已保存并即时生效" });
          dirtyRef.current = false;
          await loadConfig();
        } catch (error) { setMessage({ kind: "error", text: "保存失败：" + String(error.message || error) }); }
        finally { setBusy(false); }
      };
      const discard = () => { setRules(saved); dirtyRef.current = false; setMessage({ kind: "", text: "" }); };
      const restore = async () => {
        setBusy(true);
        try {
          if (restoreAgents.length > 1 && !restoreAgentId) throw new Error('请先选择要恢复的会话');
          const res = await fetch(RESTORE_PATH, { method: "POST",
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: restoreAgentId }) });
          const data = await res.json();
          setMessage(data.ok ? { kind: "ok", text: "已切回 " + (data.selection ? data.selection.provider + "/" + data.selection.model : "主模型") }
            : { kind: "error", text: data.reason || data.error || "恢复失败" });
          await loadConfig();
        } catch (error) { setMessage({ kind: "error", text: "恢复失败：" + String(error.message || error) }); }
        finally { setBusy(false); }
      };

      if (!rules) return h("div", { style: s.wrap },
        h("div", { style: s.card }, h("div", { style: { ...s.skeleton, width: "45%", height: 18 } }),
          h("div", { style: { ...s.skeleton, width: "80%" } }), h("div", { style: { ...s.skeleton, width: "62%" } }),
          message.text ? h("div", { style: { ...s.notice, color: C.danger, background: "rgba(224,92,88,.10)" } }, message.text) : null,
          h("button", { style: s.btn, onClick: () => { loadConfig(); loadCatalog(); } }, "重试")));

      const step = (n) => h("span", { style: s.step }, String(n));

      return h("div", { style: s.wrap },
        h("div", { style: s.header },
          h("div", { style: s.badge }, "⇄"),
          h("div", null,
            h("h2", { style: s.title }, "模型故障转移"),
            h("p", { style: s.subtitle }, "管理所有已接入模型的自动降级链。失败时按顺序切到下一档并继续任务；未加入链的模型永不自动切换。"),
            h("div", { style: { ...s.row, gap: 6, marginTop: 8 } },
              h("span", { style: rules.enabled ? s.tagOn : s.tag }, rules.enabled ? "● 已启用" : "○ 已停用"),
              h("span", { style: s.tag }, allModels.length + " 个可用模型"),
              h("span", { style: s.tag }, "链内 " + rules.priority.length + " 档"),
              dirty ? h("span", { style: { ...s.tag, background: "rgba(217,139,43,.16)", color: C.warn } }, "● 未保存") : null))),

        // 1. General settings
        h("div", { style: s.card },
          h("div", { style: s.cardHead }, h("div", { style: s.cardTitle }, step(1), "运行策略")),
          h("div", { style: s.panel },
            h("div", { style: { ...s.field, justifyContent: "center" } },
              h(Switch, { checked: rules.enabled, onChange: (v) => patch({ enabled: v }), label: "启用自动故障转移", hint: "关闭后所有降级动作停止" })),
            h(Field, { label: "每会话最多切换", value: rules.maxSwitchesPerSession, onChange: (v) => patch({ maxSwitchesPerSession: v }), min: 0, suffix: "次" }),
            h(Field, { label: "切换冷却", value: rules.cooldownMs, onChange: (v) => patch({ cooldownMs: v }), min: 0, suffix: "毫秒" }),
            h(Field, { label: "留痕上限", value: rules.switchLogLimit, onChange: (v) => patch({ switchLogLimit: v }), min: 1, suffix: "条" })),
          h("div", { style: { ...s.row, gap: 8, flexWrap: "wrap", marginTop: 12 } },
            MODES.map((m) => {
              const on = rules.mode === m.id;
              return h("button", { key: m.id, style: on ? s.chipOn : s.chip, onClick: () => patch({ mode: m.id }), title: m.hint },
                h("span", { style: { color: on ? C.accent : C.muted } }, on ? "●" : "○"),
                h("span", null, m.label));
            })),
          rules.mode !== "off" ? h("div", { style: { ...s.notice, background: C.accentSoft, color: C.accent } }, MODES.find((m) => m.id === rules.mode)?.hint) : null,
          rules.mode === "free" && rules.exhausted ? h("div", { style: { ...s.notice, background: "rgba(224,92,88,.10)", color: C.danger } },
            "免费额度已耗尽：会话已停止，不会回退到消耗积分的模型。") : null,
          h("p", { style: s.hint }, "上限与冷却用于抑制故障抖动造成的反复切换；留痕只记录最近若干次切换。")),

        // 2. Chain
        h("div", { style: s.card },
          h("div", { style: s.cardHead },
            h("div", { style: s.cardTitle }, step(2), "降级链"),
            h("span", { style: { fontSize: 11, opacity: .6 } }, "拖动或 ↑↓ 调整顺序")),
          rules.priority.length === 0
            ? h("div", { style: { ...s.notice, background: C.surface2 } }, "链为空，插件不会切换模型。请在下方目录勾选模型。")
            : rules.priority.map((x, i) => h("div", {
                key: x.provider + "/" + x.model, style: { ...s.chainRow, opacity: dragIndex === i ? .5 : 1 },
                draggable: true,
                onDragStart: () => setDragIndex(i),
                onDragOver: (e) => e.preventDefault(),
                onDrop: (e) => {
                  e.preventDefault();
                  if (dragIndex === null || dragIndex === i) return setDragIndex(null);
                  const next = [...rules.priority];
                  const [moved] = next.splice(dragIndex, 1);
                  next.splice(i, 0, moved);
                  patch({ priority: next }); setDragIndex(null);
                },
                onDragEnd: () => setDragIndex(null),
              },
              h("span", { style: s.num }, String(i + 1)),
              h("span", { style: { flex: 1, ...s.mono } }, x.provider + " / " + x.model),
              h("label", { style: { ...s.tag, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
                  background: x.free ? "rgba(47,163,107,.16)" : C.surface2, color: x.free ? C.ok : C.muted },
                  title: "标记为免费：仅「仅免费额度」模式使用" },
                h("input", { type: "checkbox", checked: x.free === true, style: { margin: 0 },
                  onChange: (event) => {
                    const marked = event.target.checked;
                    patch({ priority: rules.priority.map((y, j) => {
                      if (j !== i) return y;
                      const { free, ...rest } = y;
                      return marked ? { ...rest, free: true } : rest;
                    }) });
                  } }),
                x.free ? "免费" : "计费"),
              h("span", { style: s.tag }, i === 0 ? "主模型" : "第 " + (i + 1) + " 档"),
              h("button", { style: s.btnSmall, disabled: i === 0, onClick: () => move(i, -1) }, "↑"),
              h("button", { style: s.btnSmall, disabled: i === rules.priority.length - 1, onClick: () => move(i, 1) }, "↓"),
              h("button", { style: s.btnSmall, onClick: () => toggle(x), title: "移出链" }, "×"))),
          crossProvider ? h("div", { style: { ...s.notice, background: "rgba(217,139,43,.10)", color: C.warn } },
            "⚠ 链中包含多个 provider：切换时会丢弃其它供应商的历史 thinking 块、KV 缓存复用下降，凭据与计费也可能不同。") : null,
          h("div", { style: { ...s.row, gap: 8, marginTop: 10 } },
            h("button", { style: s.btn, onClick: () => patch({ priority: [] }) }, "清空链"),
            h("button", { style: s.btn, onClick: () => patch({ triggers: [...DEFAULT_TRIGGERS], maxSwitchesPerSession: 3, cooldownMs: 0, switchLogLimit: 20 }) }, "恢复默认参数"))),

        // 3. Catalog
        h("div", { style: s.card },
          h("div", { style: s.cardHead },
            h("div", { style: s.cardTitle }, step(3), "全部已接入模型"),
            h("span", { style: { fontSize: 11, opacity: .6 } }, "共 " + allModels.length + " 个 · 已入链 " + rules.priority.length + " 个")),
          h("input", { style: s.search, placeholder: "搜索模型名称 / ID / provider…", value: query, onChange: (e) => setQuery(e.target.value) }),
          h("div", { style: { ...s.row, gap: 8, marginBottom: 10, flexWrap: "wrap" } },
            h("button", { style: s.btn, onClick: () => {
              const visible = filtered.flatMap((g) => g.models.map((m) => ({ provider: g.id, model: m.id })));
              const keys = new Set(rules.priority.map((x) => x.provider + "/" + x.model));
              patch({ priority: [...rules.priority, ...visible.filter((x) => !keys.has(x.provider + "/" + x.model))] });
            } }, "全选当前结果"),
            h("button", { style: s.btn, onClick: () => setCollapsed({}) }, "展开全部分组"),
            h("button", { style: s.btn, onClick: () => setShowAll((v) => !v) }, showAll ? "收起长列表" : "显示全部")),
          catalogError ? h("div", { style: { ...s.notice, background: "rgba(224,92,88,.10)", color: C.danger } }, catalogError,
            h("button", { style: { ...s.btn, marginLeft: 10 }, onClick: loadCatalog }, "重试")) : null,
          !catalog.length && !catalogError ? h("div", { style: { ...s.skeleton, width: "70%" } }, "正在读取模型目录…") : null,
          filtered.map((g) => {
            const open = !collapsed[g.id] || query.trim() !== "" || showAll;
            const count = g.models.filter((m) => chainKeys.has(g.id + "/" + m.id)).length;
            return h("div", { key: g.id, style: { marginBottom: 4 } },
              h("button", { style: s.groupHead, onClick: () => setCollapsed((old) => ({ ...old, [g.id]: !old[g.id] })) },
                h("span", null, open ? "▾" : "▸"), h("span", null, g.name), h("span", { style: s.tag }, g.id),
                h("span", { style: { ...s.tag, marginLeft: "auto" } }, g.models.length + " 个"),
                count > 0 ? h("span", { style: s.tagOn }, "入链 " + count) : null),
              open ? h("div", { style: { paddingLeft: 8 } }, g.models.map((m) => {
                const key = g.id + "/" + m.id;
                const on = chainKeys.has(key);
                return h("label", { key, style: { ...s.modelRow, background: on ? C.accentSoft : "transparent", borderColor: on ? C.accentBorder : "transparent" } },
                  h("input", { type: "checkbox", checked: on, onChange: () => toggle({ provider: g.id, model: m.id }) }),
                  h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.name),
                  h("span", { style: { ...s.tag, ...s.mono } }, m.id),
                  on ? h("span", { style: s.tagOn }, "已入链") : null);
              })) : null);
          })),

        // 4. Triggers
        h("div", { style: s.card },
          h("div", { style: s.cardHead }, h("div", { style: s.cardTitle }, step(4), "触发错误码"),
            h("span", { style: { fontSize: 11, opacity: .6 } }, rules.triggers.length + " / " + ALL_TRIGGERS.length + " 已启用")),
          h("div", { style: { ...s.row, flexWrap: "wrap", gap: 7 } },
            ALL_TRIGGERS.map((code) => {
              const on = rules.triggers.includes(code);
              return h("button", { key: code, style: on ? s.chipOn : s.chip, onClick: () => toggleTrigger(code) },
                h("span", { style: { color: on ? C.accent : C.muted } }, on ? "●" : "○"),
                h("span", { style: s.mono }, code));
            })),
          h("div", { style: { ...s.row, gap: 8, marginTop: 10 } },
            h("button", { style: s.btn, onClick: () => patch({ triggers: [...DEFAULT_TRIGGERS] }) }, "全选"),
            h("button", { style: s.btn, onClick: () => patch({ triggers: [] }) }, "全不选")),
          h("p", { style: s.hint }, "另：HTTP_500–HTTP_599 与 status ≥ 500 始终视为上游错误；UNKNOWN 且消息含额度耗尽措辞也会触发。")),

        // 5. History
        h("div", { style: s.card },
          h("div", { style: s.cardHead }, h("div", { style: s.cardTitle }, step(5), "切换留痕与恢复"),
            h("span", { style: s.row },
              h("select", { style: s.input, value: restoreAgentId, onChange: e => setRestoreAgentId(e.target.value), title: '选择需要恢复的 DSH 会话' },
                h("option", { value: '' }, restoreAgents.length === 1 ? '当前唯一会话' : '选择目标会话'),
                restoreAgents.map(id => h("option", { key: id, value: id }, id))),
              h("button", { style: s.btn, disabled: busy || (restoreAgents.length > 1 && !restoreAgentId), onClick: restore }, "切回链首主模型"))),
          (rules.switchLog || []).length === 0
            ? h("p", { style: { ...s.hint, margin: 0 } }, "暂无切换记录。发生额度/上游故障并降级后，这里会显示时间、原因与从→到。")
            : [...rules.switchLog].reverse().slice(0, 10).map((row, i) => h("div", { key: i, style: s.logRow },
              h("span", { style: { opacity: .6, ...s.mono } }, new Date(row.at).toLocaleString()),
              h("span", { style: { flex: 1, ...s.mono } }, row.from + " → " + row.to),
              h("span", { style: s.tag }, row.code)))),

        h("div", { style: s.footer },
          h("button", { style: { ...s.primary, opacity: !dirty || busy ? .5 : 1, cursor: !dirty || busy ? "default" : "pointer" }, disabled: !dirty || busy, onClick: save }, busy ? "保存中…" : dirty ? "保存更改" : "已保存"),
          h("button", { style: s.btn, disabled: !dirty || busy, onClick: discard }, "放弃更改"),
          h("button", { style: s.btn, disabled: busy, onClick: () => { loadConfig(); loadCatalog(); } }, "重新读取"),
          message.text ? h("span", { style: { fontSize: 12, color: message.kind === "error" ? C.danger : message.kind === "ok" ? C.ok : C.muted } }, message.text) : null,
          dirty ? h("span", { style: { fontSize: 11, color: C.warn, marginLeft: "auto" } }, "有未保存的更改") : null),
        h("p", { style: { ...s.hint, marginTop: 4 } }, "DSH 每步冻结模型路由，切换只对下一步 / 新轮次生效；QUOTA 不在内置「继续」白名单内，插件会自行排队续跑。WorkBuddy 会先内部轮换账号。")
      );
    }


    /**
     * Chain-scoped mode entries for the chat composer's model menu.
     * Selecting one switches the session mode; the mode is stored in the same
     * config the settings page edits, so both surfaces always agree.
     */
    function ModelModeOptions(props) {
      const [mode, setMode] = useState(null);
      const [exhausted, setExhausted] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");

      const load = useCallback(async () => {
        try {
          const res = await fetch(CONFIG_PATH);
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "config read failed");
          const next = data.rules && (data.rules.mode === "pinned" || data.rules.mode === "free") ? data.rules.mode : "off";
          setMode(next);
          setExhausted(data.rules?.exhausted === true);
          setError("");
        } catch (cause) { setError(String(cause && cause.message || cause)); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const choose = useCallback(async (next) => {
        if (busy) return;
        setBusy(true);
        try {
          const res = await fetch(CONFIG_PATH, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: next }) });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "save failed");
          setMode(next);
          setExhausted(false);
          setError("");
          try { props.dismiss?.(); } catch { /* menu already closed */ }
        } catch (cause) {
          const text = String(cause && cause.message || cause);
          setError(text);
          try { props.reportFailure?.("切换模式失败：" + text); } catch { /* toast optional */ }
        } finally { setBusy(false); }
      }, [busy, props]);

      if (error) return h("div", { style: { padding: "8px 12px", fontSize: 11, opacity: .75 } }, "模式读取失败：" + error);

      const rows = [
        { id: "pinned", label: "仅用降级链", hint: "只使用降级链内模型" },
        { id: "free", label: "仅免费额度", hint: exhausted ? "免费档已耗尽，会话已停止" : "只用链内标记为免费的模型" },
        { id: "off", label: "关闭（正常）", hint: "恢复正常模型选择" },
      ];
      return h("div", { role: "group", "aria-label": "降级链模式" },
        h("div", { style: { padding: "6px 12px 2px", fontSize: 10, opacity: .55, textTransform: "uppercase", letterSpacing: ".06em" } }, "降级链模式"),
        rows.map((row) => {
          const on = mode === row.id;
          return h("button", {
            key: row.id,
            type: "button",
            role: "menuitemradio",
            "aria-checked": on,
            disabled: busy || (props.locked === true && !on),
            onClick: () => choose(row.id),
            style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px",
              background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: 12,
              textAlign: "left", opacity: props.locked === true && !on ? .5 : 1 },
          },
            h("span", { style: { width: 14, color: on ? "#4c8dff" : "transparent" } }, "✓"),
            h("span", { style: { flex: 1 } }, row.label),
            h("span", { style: { fontSize: 10.5, opacity: .55 } }, row.hint));
        }));
    }

    function apply(ctx) {
      const slots = ctx?.slots ?? ctx?.get?.("slots");
      if (!slots?.inject || !slots?.register) {
        console.warn("[" + NS + "] slots service unavailable; settings card skipped");
        return;
      }
      const dispose = slots.inject("settings.section", () =>
        slots.register({ name: "settings.section", id: SECTION_ID, order: 65, label: () => "模型故障转移", locale: NS },
          (props) => h(Card, { ...props, ctx })));
      ctx.effect?.(() => () => { try { dispose?.(); } catch {} }, NS + " settings section");
      console.info("[" + NS + "] settings.section registered");

      // Chat composer model menu: append the two chain-scoped modes so the
      // choice is made where the model itself is chosen.
      if (slots.inject && slots.register) {
        try {
          const disposeMenu = slots.inject("conversation.input.model.options", () =>
            slots.register({ name: "conversation.input.model.options", id: NS + "-mode", order: 90 },
              (props) => h(ModelModeOptions, { ...props, ctx })));
          ctx.effect?.(() => () => { try { disposeMenu?.(); } catch {} }, NS + " model options");
          console.info("[" + NS + "] conversation.input.model.options registered");
        } catch (error) {
          console.warn("[" + NS + "] model options slot unavailable: " + String(error && error.message || error));
        }
      }
    }
    const inject = ["slots", "remote", "remote.session"];
    apply.inject = inject;
    return { apply, name: NS, inject };
  },
});
