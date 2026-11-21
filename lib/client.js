window.__ModuleLoader__.load({
  id: "dsh-work-assistant",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const React = require("react")
    const ReactDOM = require("react-dom")
    const h = React.createElement
    const zodNamespace = require("zod")
    const z = zodNamespace && zodNamespace.z ? zodNamespace.z : zodNamespace

    /* ------------------------------------------------------------------ *
     * Remote contribution
     *
     * 宿主侧 lib/index.js 用 Typert Gateway 的「源码回退」通道暴露方法。
     * 浏览器侧必须提供同形状的 contribution 才能 $mount 命名空间。
     * ------------------------------------------------------------------ */

    const PACKAGE = "dsh-work-assistant"
    const anySchema = () => z.any()

    function makeDescriptor(method, description, withSignal) {
      return Object.freeze({
        id: PACKAGE + "#workAssistant/" + method,
        service: "workAssistant",
        namespace: "workAssistant",
        method,
        description,
        invocation: Object.freeze({ kind: "direct" }),
        parameters: Object.freeze([
          Object.freeze({
            name: "request",
            wire: "request",
            description: "请求参数",
            source: "json",
            codec: Object.freeze({ mode: "strict", typeSymbol: PACKAGE + "#" + method + ":request", create: anySchema }),
          }),
        ]),
        ...(withSignal ? { cancellation: Object.freeze({ parameter: "signal" }) } : {}),
        result: Object.freeze({ mode: "src-json" }),
      })
    }

    const refineDescriptor = makeDescriptor("refine", "把原始命令整理成结构化提示词", true)
    const planDescriptor = makeDescriptor("planFlow", "把目标拆成依赖明确的工作流", true)
    const composeStepDescriptor = makeDescriptor("composeStep", "结合前置输出为某一步生成指令", true)
    const planProjectDescriptor = makeDescriptor("planProject", "把复杂目标拆成项目式工作流", true)
    const prepareProjectDescriptor = makeDescriptor("prepareProject", "准备工作目录", false)
    const setAutoApprovalDescriptor = makeDescriptor("setAutoApproval", "同步需要自动审核的会话", false)
    const loadSettingsDescriptor = makeDescriptor("loadSettings", "读取保存的设置", false)
    const saveSettingsDescriptor = makeDescriptor("saveSettings", "保存设置", false)
    const pingDescriptor = Object.freeze({
      id: PACKAGE + "#workAssistant/ping",
      service: "workAssistant",
      namespace: "workAssistant",
      method: "ping",
      description: "连通性自检",
      invocation: Object.freeze({ kind: "direct" }),
      parameters: Object.freeze([]),
      result: Object.freeze({ mode: "src-json" }),
    })

    const remoteContribution = {
      package: PACKAGE,
      face: "client",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      descriptors: [refineDescriptor, planDescriptor, composeStepDescriptor, planProjectDescriptor, prepareProjectDescriptor, setAutoApprovalDescriptor, loadSettingsDescriptor, saveSettingsDescriptor, pingDescriptor],
      invocations: [refineDescriptor, planDescriptor, composeStepDescriptor, planProjectDescriptor, prepareProjectDescriptor, setAutoApprovalDescriptor, loadSettingsDescriptor, saveSettingsDescriptor, pingDescriptor],
    }

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    const PREF_KEY = "dsh-work-assistant:prefs:v1"
    const CARD_WIDTH = 440
    const CARD_MAX_HEIGHT = 640
    const EDGE = 16
    const WAIT_TIMEOUT_MS = 20 * 60 * 1000
    const POLL_INTERVAL_MS = 2500

    const FLOW_STEPS = [
      { key: "extract", label: "提取源实现" },
      { key: "spec", label: "生成统一规格" },
      { key: "compose", label: "生成目标指令" },
      { key: "dispatch", label: "分发到目标对话" },
      { key: "collect", label: "等待并收集结果" },
      { key: "review", label: "对齐复核" },
    ]

    /* ------------------------------------------------------------------ *
     * 小工具
     * ------------------------------------------------------------------ */

    let idCounter = 0

    function makeId(prefix) {
      idCounter += 1
      try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return prefix + crypto.randomUUID()
      } catch (_) {
        /* 降级到计数器 */
      }
      return prefix + Date.now().toString(36) + "-" + idCounter
    }

    function basename(input) {
      if (typeof input !== "string") return ""
      const parts = input.split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? input : parts[parts.length - 1]
    }

    function toMillis(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0
      return value > 1e12 ? value : value * 1000
    }

    function relativeTime(value) {
      const ms = toMillis(value)
      if (ms === 0) return ""
      const diff = Date.now() - ms
      if (diff < 60 * 1000) return "刚刚"
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前"
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " 小时前"
      return Math.floor(diff / 86400000) + " 天前"
    }

    function clockTime(value) {
      try {
        return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      } catch (_) {
        return ""
      }
    }

    function shortText(text, limit) {
      const value = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : ""
      return value.length > limit ? value.slice(0, limit) + "…" : value
    }

    function titleOfRow(row) {
      const projected = row && row.projections && row.projections.values ? row.projections.values.title : undefined
      if (typeof projected === "string" && projected.trim() !== "") return projected.trim()
      if (typeof row.title === "string" && row.title.trim() !== "") return row.title.trim()
      const dir = row && typeof row.cwd === "string" && row.cwd !== "" ? basename(row.cwd) : ""
      if (dir !== "") return dir + "（未命名会话）"
      return "会话 " + String(row.sessionId).slice(0, 8)
    }

    function errorMessage(reason) {
      let text
      if (reason === null || reason === undefined) text = "未知错误"
      else if (typeof reason === "string") text = reason
      else if (typeof reason.message === "string" && reason.message !== "") text = reason.message
      else if (reason.error && typeof reason.error.message === "string") text = reason.error.message
      else {
        try {
          text = JSON.stringify(reason)
        } catch (_) {
          text = String(reason)
        }
      }
      return text
    }

    /* ------------------------------------------------------------------ *
     * 项目 / 对话分组
     * ------------------------------------------------------------------ */

    function projectNameOf(cwd) {
      const name = basename(cwd)
      return name === "" ? "未指定目录" : name
    }

    function groupProjects(sessions) {
      const map = new Map()
      for (const row of sessions) {
        const key = row.cwd || ""
        let entry = map.get(key)
        if (entry === undefined) {
          entry = { path: key, name: projectNameOf(key), sessions: [], latest: 0 }
          map.set(key, entry)
        }
        entry.sessions.push(row)
        entry.latest = Math.max(entry.latest, toMillis(row.updatedAt))
      }
      const projects = Array.from(map.values())
      for (const project of projects) project.sessions.sort((left, right) => toMillis(right.updatedAt) - toMillis(left.updatedAt))
      projects.sort((left, right) => right.latest - left.latest)
      return projects
    }

    function projectLabel(project, projects) {
      const duplicate = projects.filter((candidate) => candidate.name === project.name).length > 1
      if (!duplicate) return project.name + "（" + project.sessions.length + "）"
      const parts = project.path.split(/[\\/]+/).filter(Boolean)
      const parent = parts.length > 1 ? parts[parts.length - 2] : ""
      return project.name + " — " + parent + "（" + project.sessions.length + "）"
    }

    function resolveSessionFor(project, defaults, pinned) {
      if (project === null || project.sessions.length === 0) return null
      const pinnedId = pinned[project.path]
      if (typeof pinnedId === "string" && project.sessions.some((row) => row.id === pinnedId)) return pinnedId
      const lastId = defaults[project.path]
      if (typeof lastId === "string" && project.sessions.some((row) => row.id === lastId)) return lastId
      return project.sessions[0].id
    }

    /** 托管清单里是否包含该会话。 */
    function isManaged(managed, sessionId) {
      return managed.some((entry) => entry.id === sessionId)
    }

    function managedEntry(managed, sessionId) {
      return managed.find((entry) => entry.id === sessionId) || null
    }

    /* ------------------------------------------------------------------ *
     * 位置与偏好持久化
     * ------------------------------------------------------------------ */

    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(PREF_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === "object" ? parsed : {}
      } catch (_) {
        return {}
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
      } catch (_) {
        /* 隐私模式下忽略 */
      }
    }

    function defaultPosition(height) {
      try {
        const x = Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE)
        const y = Math.max(EDGE, window.innerHeight - (height || CARD_MAX_HEIGHT) - EDGE)
        return { x, y }
      } catch (_) {
        return { x: 24, y: 24 }
      }
    }

    function clampPosition(position, width, height) {
      try {
        const maxX = Math.max(EDGE, window.innerWidth - width - EDGE)
        const maxY = Math.max(EDGE, window.innerHeight - height - EDGE)
        return {
          x: Math.min(Math.max(8, position.x), maxX),
          y: Math.min(Math.max(8, position.y), maxY),
        }
      } catch (_) {
        return position
      }
    }

    /* ------------------------------------------------------------------ *
     * 提示音
     * ------------------------------------------------------------------ */

    let audioContext = null

    function ensureAudio() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        if (audioContext === null) audioContext = new Ctor()
        if (audioContext.state === "suspended") audioContext.resume()
        return audioContext
      } catch (_) {
        return null
      }
    }

    function playChime() {
      const ctx = ensureAudio()
      if (ctx === null) return
      const start = ctx.currentTime
      const notes = [880, 1174.66, 1567.98]
      notes.forEach((frequency, index) => {
        const at = start + index * 0.16
        const oscillator = ctx.createOscillator()
        const gain = ctx.createGain()
        oscillator.type = "sine"
        oscillator.frequency.setValueAtTime(frequency, at)
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42)
        oscillator.connect(gain)
        gain.connect(ctx.destination)
        oscillator.start(at)
        oscillator.stop(at + 0.45)
      })
    }

    /**
     * 朗读一段文字。用浏览器内置的 speechSynthesis；不支持时静默跳过。
     * 语言/音色暂用系统默认的中文声音（待确认）。
     */
    function speak(text) {
      try {
        const synth = window.speechSynthesis
        const Utterance = window.SpeechSynthesisUtterance
        if (!synth || typeof Utterance !== "function") return
        synth.cancel()
        const utterance = new Utterance(String(text || ""))
        utterance.lang = "zh-CN"
        synth.speak(utterance)
      } catch (_) {
        /* 朗读失败不影响其它提示 */
      }
    }

    /* ------------------------------------------------------------------ *
     * 主题
     * ------------------------------------------------------------------ */

    function detectDark() {
      try {
        const body = document.body
        if (body === null) return false
        const raw = getComputedStyle(body).backgroundColor
        const match = /rgba?\(([^)]+)\)/.exec(raw)
        if (match === null) return false
        const parts = match[1].split(",").map((piece) => parseFloat(piece))
        const alpha = parts.length > 3 ? parts[3] : 1
        if (alpha === 0) return false
        const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
        return luminance < 0.45
      } catch (_) {
        return false
      }
    }

    function paletteFor(dark) {
      // 直接用 harness 的主题变量，颜色跟着它的明暗和自定义主题走；
      // 变量不存在时退回内置色，保证面板不会变成透明。
      const token = (name, fallback) => "var(" + name + ", " + fallback + ")"
      return {
        panel: token("--dsw-alias-bg-base", dark ? "#23242b" : "#ffffff"),
        panelAlt: token("--dsw-alias-bg-layer-1", dark ? "#2c2d36" : "#f5f6f8"),
        text: token("--dsw-alias-label-primary", dark ? "#ececf1" : "#1b1c22"),
        muted: token("--dsw-alias-label-secondary", dark ? "#9b9ca8" : "#6b6d78"),
        border: token("--dsw-alias-border-l1", dark ? "#3b3c46" : "#e2e3e8"),
        accent: token("--dsw-alias-brand-primary", dark ? "#ededf0" : "#14151a"),
        accentText: token("--dsw-alias-label-primary-foreground", dark ? "#14151a" : "#ffffff"),
        danger: token("--dsw-alias-state-error-primary", dark ? "#ff8b8b" : "#c0392b"),
        success: token("--dsw-alias-state-success-primary", dark ? "#5fd39a" : "#1f9d63"),
        hover: token("--dsw-alias-interactive-bg-hover", dark ? "#343642" : "#eef0f5"),
        shadow: dark ? "0 18px 50px rgba(0, 0, 0, 0.55)" : "0 18px 50px rgba(16, 20, 34, 0.22)",
      }
    }

    /** 当前明暗状态的外部存储：主题服务、媒体查询、DOM 变化三路更新。 */
    const themeBridge = {
      current: null,
      listeners: new Set(),
      get() {
        return this.current === null ? detectDark() : this.current
      },
      set(next) {
        const value = next === true
        if (this.current === value) return
        this.current = value
        for (const listener of Array.from(this.listeners)) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    }

    function useDarkMode() {
      return React.useSyncExternalStore(themeBridge.subscribe, themeBridge.get, themeBridge.get)
    }

    /** 订阅 harness 的 `theme` 服务；拿不到就退回媒体查询与 DOM 观察。 */
    function initThemeBridge(ctx) {
      const read = () => {
        try {
          const theme = typeof ctx.get === "function" ? ctx.get("theme") : undefined
          const snapshot = theme && typeof theme.getTheme === "function" ? theme.getTheme() : undefined
          const scheme = snapshot && snapshot.colorScheme
          if (scheme === "dark") return true
          if (scheme === "light") return false
        } catch (_) {
          /* 继续用 DOM 判断 */
        }
        return detectDark()
      }

      themeBridge.set(read())

      try {
        ctx.on("theme/change", (snapshot) => {
          const scheme = snapshot && snapshot.colorScheme
          themeBridge.set(scheme === "dark" ? true : scheme === "light" ? false : read())
        })
      } catch (_) {
        /* 事件订阅失败时仍有下面的兜底 */
      }

      try {
        const media = window.matchMedia("(prefers-color-scheme: dark)")
        const onChange = () => themeBridge.set(read())
        if (typeof media.addEventListener === "function") media.addEventListener("change", onChange)
      } catch (_) {
        /* 忽略 */
      }

      try {
        const observer = new MutationObserver(() => themeBridge.set(read()))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
        if (document.body !== null) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] })
      } catch (_) {
        /* 忽略 */
      }
    }

    /* ------------------------------------------------------------------ *
     * Store
     * ------------------------------------------------------------------ */

    function createStore(prefs) {
      const managed = Array.isArray(prefs.managed)
        ? prefs.managed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.project === "string")
        : []
      const managerPrefs = prefs.manager && typeof prefs.manager === "object" ? prefs.manager : {}
      const settingsPrefs = prefs.settings && typeof prefs.settings === "object" ? prefs.settings : {}
      const autoPrefs = prefs.auto && typeof prefs.auto === "object" ? prefs.auto : {}
      const autoApprovePrefs = prefs.autoApprove && typeof prefs.autoApprove === "object" ? prefs.autoApprove : null
      // 自动审核的初始值：用户显式设置过就用保存的，否则用「设置」里的默认。
      const autoApproveDefault = settingsPrefs.autoApproveDefault !== false
      const autoApproveInitial = (feature) =>
        autoApprovePrefs === null ? autoApproveDefault : autoApprovePrefs[feature] === true

      let state = {
        open: prefs.open !== false,
        minimized: prefs.minimized === true,
        position: prefs.position !== undefined && prefs.position !== null ? prefs.position : null,
        tab: ["manager", "auto", "settings"].includes(prefs.tab) ? prefs.tab : "prompt",
        sessions: [],
        sessionsLoading: false,
        sessionsError: null,
        projectPath: typeof prefs.projectPath === "string" ? prefs.projectPath : null,
        selectedId: prefs.selectedId !== undefined ? prefs.selectedId : null,
        defaults: prefs.defaults && typeof prefs.defaults === "object" ? prefs.defaults : {},
        pinned: prefs.pinned && typeof prefs.pinned === "object" ? prefs.pinned : {},
        raw: "",
        refined: "",
        refinedSource: "",
        refinedWarning: "",
        refining: false,
        sending: false,
        error: null,
        tasks: [],
        toast: null,
        managed,
        settings: {
          autoApproveDefault,
          autoReviewDefault: settingsPrefs.autoReviewDefault !== false,
          autoProjectRootDefault:
            typeof settingsPrefs.autoProjectRootDefault === "string" ? settingsPrefs.autoProjectRootDefault : "",
          notifyMode: settingsPrefs.notifyMode === "read" ? "read" : "sound",
          muted: settingsPrefs.muted === true,
        },
        autoApprove: {
          prompt: autoApproveInitial("prompt"),
          manager: autoApproveInitial("manager"),
          auto: autoApproveInitial("auto"),
        },
        auto: {
          goal: typeof autoPrefs.goal === "string" ? autoPrefs.goal : "",
          projectRoot:
            typeof autoPrefs.projectRoot === "string" && autoPrefs.projectRoot !== ""
              ? autoPrefs.projectRoot
              : settingsPrefs.autoProjectRootDefault || "",
          review:
            autoPrefs.review !== undefined
              ? autoPrefs.review !== false
              : settingsPrefs.autoReviewDefault !== false,
          planning: false,
          plan: null,
          planWarning: "",
          run: null,
          selectedStepId: null,
          running: false,
          finished: false,
          statusText: "",
          error: null,
        },
        manager: {
          sourceId: typeof managerPrefs.sourceId === "string" ? managerPrefs.sourceId : null,
          targetIds: Array.isArray(managerPrefs.targetIds) ? managerPrefs.targetIds.filter((id) => typeof id === "string") : [],
          requirement: typeof managerPrefs.requirement === "string" ? managerPrefs.requirement : "",
          includeReview: managerPrefs.includeReview !== false,
          showConfig: true,
          addProject: "",
          addSessionId: "",
          planning: false,
          plan: null,
          planWarning: "",
          run: null,
          selectedStepId: null,
          running: false,
          finished: false,
          statusText: "",
          error: null,
        },
      }
      const listeners = new Set()
      const get = () => state
      const set = (patch) => {
        const next = typeof patch === "function" ? patch(state) : patch
        state = Object.assign({}, state, next)
        for (const listener of Array.from(listeners)) listener()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      const persist = () => {
        savePrefs({
          open: state.open,
          minimized: state.minimized,
          position: state.position,
          tab: state.tab,
          projectPath: state.projectPath,
          selectedId: state.selectedId,
          defaults: state.defaults,
          pinned: state.pinned,
          managed: state.managed,
          settings: state.settings,
          autoApprove: state.autoApprove,
          auto: {
            goal: state.auto.goal,
            projectRoot: state.auto.projectRoot,
            review: state.auto.review,
          },
          manager: {
            sourceId: state.manager.sourceId,
            targetIds: state.manager.targetIds,
            requirement: state.manager.requirement,
            includeReview: state.manager.includeReview,
          },
        })
      }
      return { get, set, subscribe, persist }
    }

    /* ------------------------------------------------------------------ *
     * 样式片段
     * ------------------------------------------------------------------ */

    function buttonStyle(tokens, variant, disabled) {
      return {
        appearance: "none",
        border: "1px solid " + (variant === "primary" ? tokens.accent : tokens.border),
        background: variant === "primary" ? tokens.accent : "transparent",
        color: variant === "primary" ? tokens.accentText : tokens.text,
        borderRadius: 7,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: "18px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background 120ms ease, opacity 120ms ease",
        whiteSpace: "nowrap",
      }
    }

    function iconButtonStyle(tokens) {
      return {
        appearance: "none",
        border: "none",
        background: "transparent",
        color: tokens.muted,
        width: 24,
        height: 24,
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 15,
        lineHeight: "20px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }
    }

    function labelStyle(tokens) {
      return { fontSize: 11, fontWeight: 700, color: tokens.muted, letterSpacing: "0.02em", margin: "12px 0 5px" }
    }

    function fieldStyle(tokens) {
      return {
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 9px",
        borderRadius: 7,
        border: "1px solid " + tokens.border,
        background: tokens.panelAlt,
        color: tokens.text,
        fontSize: 12,
        lineHeight: 1.55,
        fontFamily: "inherit",
        outline: "none",
        resize: "vertical",
      }
    }

    function smallTextStyle(tokens) {
      return { fontSize: 10, color: tokens.muted, lineHeight: 1.5 }
    }

    /* ------------------------------------------------------------------ *
     * 通用组件
     * ------------------------------------------------------------------ */

    function AssistantButton(props) {
      const api = props.api
      const state = React.useSyncExternalStore(api.store.subscribe, api.store.get, api.store.get)
      const dark = useDarkMode()
      const tokens = React.useMemo(() => paletteFor(dark), [dark])
      const running = state.tasks.filter((task) => task.status === "running").length + (state.manager.running ? 1 : 0)
      return h(
        "button",
        {
          type: "button",
          title: "工作助手：浮窗显示/隐藏",
          onClick: () => api.toggle(),
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            margin: "2px 0",
            border: "1px solid " + tokens.border,
            borderRadius: 8,
            background: state.open && !state.minimized ? tokens.hover : "transparent",
            color: tokens.text,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            textAlign: "left",
          },
        },
        h("span", { style: { flex: 1 } }, "工作助手"),
        running > 0
          ? h(
              "span",
              {
                style: {
                  minWidth: 18,
                  height: 18,
                  padding: "0 5px",
                  borderRadius: 9,
                  background: tokens.accent,
                  color: tokens.accentText,
                  fontSize: 11,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                },
              },
              String(running),
            )
          : null,
      )
    }

    function TabBar({ tokens, tab, onSelect }) {
      const tabs = [
        { key: "prompt", label: "基础提示词" },
        { key: "manager", label: "多任务管理员" },
        { key: "auto", label: "自主助理" },
        { key: "settings", label: "设置" },
      ]
      return h(
        "div",
        {
          style: {
            display: "flex",
            gap: 4,
            padding: "6px 10px 0",
            borderBottom: "1px solid " + tokens.border,
            flex: "none",
          },
        },
        tabs.map((item) =>
          h(
            "button",
            {
              key: item.key,
              type: "button",
              onClick: () => onSelect(item.key),
              style: {
                appearance: "none",
                border: "none",
                background: "transparent",
                padding: "6px 10px 8px",
                marginBottom: -1,
                borderBottom: "2px solid " + (tab === item.key ? tokens.accent : "transparent"),
                color: tab === item.key ? tokens.text : tokens.muted,
                fontSize: 12,
                fontWeight: tab === item.key ? 700 : 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              },
            },
            item.label,
          ),
        ),
      )
    }

    function AutoApproveToggle({ tokens, api, feature, enabled, hint }) {
      return h(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
            marginTop: 8,
            fontSize: 11,
            color: tokens.text,
            cursor: "pointer",
          },
        },
        h("input", {
          type: "checkbox",
          checked: enabled,
          onChange: () => api.toggleAutoApprove(feature),
          style: { marginTop: 2 },
        }),
        h(
          "span",
          null,
          h("span", null, "自动审核权限请求"),
          h("span", { style: { display: "block", fontSize: 10, color: tokens.muted, lineHeight: 1.5, marginTop: 1 } }, hint),
        ),
      )
    }

    function TaskRow({ tokens, task }) {
      const statusText = task.status === "running" ? "执行中" : task.status === "done" ? "已完成" : "已发送"
      const color = task.status === "running" ? tokens.accent : task.status === "done" ? tokens.success : tokens.muted
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 8px",
            marginBottom: 4,
            borderRadius: 6,
            border: "1px solid " + tokens.border,
            background: tokens.panelAlt,
            fontSize: 11,
          },
        },
        h("span", { style: { width: 6, height: 6, borderRadius: 3, background: color, flex: "none" } }),
        h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, task.title),
        h("span", { style: { color, fontWeight: 600, flex: "none" } }, statusText),
        task.status === "done" ? h("span", { style: { color: tokens.muted, flex: "none" } }, clockTime(task.finishedAt || Date.now())) : null,
      )
    }

    function Toast({ tokens, toast, onClose }) {
      React.useEffect(() => {
        if (toast === null) return undefined
        const timer = window.setTimeout(onClose, 9000)
        return () => window.clearTimeout(timer)
      }, [toast])
      if (toast === null) return null
      return h(
        "div",
        {
          style: {
            position: "fixed",
            top: EDGE,
            right: EDGE,
            zIndex: 2147483000,
            maxWidth: 340,
            padding: "11px 13px",
            borderRadius: 10,
            background: tokens.panel,
            color: tokens.text,
            border: "1px solid " + tokens.border,
            borderLeft: "3px solid " + tokens.success,
            boxShadow: tokens.shadow,
            fontSize: 12,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          },
          role: "status",
        },
        h(
          "div",
          { style: { flex: 1 } },
          h("div", { style: { fontWeight: 700, marginBottom: 2 } }, toast.title || "任务已完成"),
          h("div", { style: { color: tokens.muted, lineHeight: 1.5 } }, toast.body || ""),
        ),
        h(
          "button",
          {
            type: "button",
            onClick: onClose,
            style: Object.assign(iconButtonStyle(tokens), { width: 18, height: 18, fontSize: 14 }),
            title: "关闭",
          },
          "×",
        ),
      )
    }

    function StepList({ tokens, step, running }) {
      const order = FLOW_STEPS.map((item) => item.key)
      const currentIndex = order.indexOf(step)
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 3, marginTop: 6 } },
        FLOW_STEPS.map((item, index) => {
          let status = "pending"
          if (step === "done") status = "done"
          else if (step === "error") status = index < Math.max(currentIndex, 0) ? "done" : index === Math.max(currentIndex, 0) ? "error" : "pending"
          else if (currentIndex >= 0) status = index < currentIndex ? "done" : index === currentIndex ? "running" : "pending"
          const color =
            status === "done" ? tokens.success : status === "error" ? tokens.danger : status === "running" ? tokens.accent : tokens.muted
          return h(
            "div",
            { key: item.key, style: { display: "flex", alignItems: "center", gap: 7, fontSize: 11 } },
            h("span", { style: { width: 6, height: 6, borderRadius: 3, background: color, flex: "none", opacity: status === "pending" ? 0.4 : 1 } }),
            h("span", { style: { color: status === "pending" ? tokens.muted : tokens.text } }, item.label),
            status === "running" ? h("span", { style: { color: tokens.accent, marginLeft: "auto" } }, running ? "进行中" : "已停止") : null,
          )
        }),
      )
    }

    function LogList({ tokens, log }) {
      if (!log || log.length === 0) return null
      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 2,
            marginTop: 8,
            maxHeight: 120,
            overflowY: "auto",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid " + tokens.border,
            background: tokens.panelAlt,
          },
        },
        log.map((line) =>
          h(
            "div",
            {
              key: line.id,
              style: {
                fontSize: 10,
                lineHeight: 1.5,
                color: line.kind === "error" ? tokens.danger : line.kind === "ok" ? tokens.success : tokens.muted,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              },
            },
            (line.kind === "error" ? "失败 " : line.kind === "ok" ? "完成 " : "· ") + line.text,
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 标签页一：基础提示词工程
     * ------------------------------------------------------------------ */

    function PromptTab({ api, tokens, state }) {
      const running = state.tasks.filter((task) => task.status === "running").length

      // 两级选择：先项目，再项目里的对话。
      const projects = groupProjects(state.sessions)
      const project = projects.find((candidate) => candidate.path === state.projectPath) || null
      const projectSessions = project === null ? [] : project.sessions
      const selected = projectSessions.find((row) => row.id === state.selectedId) || null
      const pinnedId = state.projectPath === null ? undefined : state.pinned[state.projectPath]
      const isPinned = pinnedId !== undefined && pinnedId === state.selectedId

      const canRefine = state.raw.trim() !== "" && !state.refining
      const canSend = state.refined.trim() !== "" && state.selectedId !== null && !state.sending

      return h(
        "div",
        { style: { padding: "4px 12px 12px" } },
          state.error !== null
            ? h(
                "div",
                {
                  style: {
                    marginTop: 8,
                    padding: "7px 9px",
                    borderRadius: 6,
                    border: "1px solid " + tokens.danger,
                    background: "rgba(255,90,90,0.08)",
                    color: tokens.danger,
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  },
                },
                state.error,
              )
            : null,

          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: labelStyle(tokens) }, "项目"),
            state.sessionsLoading ? h("span", { style: { fontSize: 10, color: tokens.muted, marginTop: 12 } }, "读取中") : null,
            h(
              "button",
              {
                type: "button",
                onClick: () => api.refreshSessions(),
                style: {
                  marginLeft: "auto",
                  marginTop: 12,
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  color: tokens.accent,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  padding: 0,
                },
                title: "刷新项目和对话列表",
              },
              "刷新",
            ),
          ),
          h(
            "select",
            {
              value: state.projectPath === null ? "" : state.projectPath,
              onChange: (event) => api.selectProject(event.target.value),
              style: Object.assign(fieldStyle(tokens), { cursor: "pointer" }),
            },
            state.projectPath === null ? h("option", { value: "" }, "请选择项目…") : null,
            projects.map((candidate) =>
              h("option", { key: candidate.path, value: candidate.path }, projectLabel(candidate, projects)),
            ),
          ),
          h(
            "div",
            {
              style: {
                marginTop: 4,
                fontSize: 10,
                color: tokens.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
              title: project === null ? "" : project.path,
            },
            project === null ? "选择项目后，下面的对话列表只显示这个项目" : project.path,
          ),

          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: labelStyle(tokens) }, "对话"),
            h(
              "button",
              {
                type: "button",
                onClick: () => api.togglePin(),
                disabled: state.selectedId === null || state.projectPath === null,
                title: isPinned ? "取消该项目的默认对话" : "把当前对话固定为这个项目的默认，下次选项目时直接用它",
                style: {
                  marginLeft: "auto",
                  marginTop: 12,
                  appearance: "none",
                  border: "none",
                  background: "transparent",
                  color: isPinned ? tokens.accent : tokens.muted,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: state.selectedId === null ? "not-allowed" : "pointer",
                  opacity: state.selectedId === null ? 0.4 : 1,
                  padding: 0,
                },
              },
              isPinned ? "已固定为默认" : "设为默认",
            ),
          ),
          h(
            "select",
            {
              value: state.selectedId === null ? "" : state.selectedId,
              onChange: (event) => api.selectSession(event.target.value),
              disabled: project === null,
              style: Object.assign(fieldStyle(tokens), { cursor: project === null ? "not-allowed" : "pointer", opacity: project === null ? 0.5 : 1 }),
            },
            state.selectedId === null ? h("option", { value: "" }, project === null ? "先选项目…" : "请选择对话…") : null,
            projectSessions.map((row) =>
              h("option", { key: row.id, value: row.id }, row.title + (row.running ? " · 运行中" : "")),
            ),
          ),
          h(
            "div",
            { style: { marginTop: 4, fontSize: 10, color: tokens.muted, display: "flex", gap: 8 } },
            h(
              "span",
              { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              selected === null
                ? project === null
                  ? ""
                  : project.sessions.length + " 个对话"
                : "最近活动 " + (relativeTime(selected.updatedAt) || "未知") + (selected.running ? " · 运行中" : ""),
            ),
          ),
          state.sessionsError !== null
            ? h("div", { style: { marginTop: 4, fontSize: 11, color: tokens.danger } }, state.sessionsError)
            : null,

          h("div", { style: labelStyle(tokens) }, "原始命令"),
          h("textarea", {
            value: state.raw,
            rows: 3,
            placeholder: "口语化写下你的需求，例如：帮我做个 3D 机器人，绑骨骼，最后给 GLB。",
            onChange: (event) => api.setRaw(event.target.value),
            style: fieldStyle(tokens),
          }),
          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 8 } },
            h(
              "button",
              {
                type: "button",
                disabled: !canRefine,
                onClick: () => api.refine(),
                style: buttonStyle(tokens, "primary", !canRefine),
              },
              state.refining ? "整理中…" : "整理命令",
            ),
            h(
              "span",
              { style: { fontSize: 10, color: tokens.muted, alignSelf: "center", lineHeight: 1.4 } },
              "整理成 #role / #goal / #output 结构",
            ),
          ),

          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: labelStyle(tokens) }, "整理结果"),
            state.refinedSource === "model"
              ? h("span", { style: { fontSize: 10, color: tokens.muted, marginTop: 12 } }, "模型生成 · 可编辑")
              : state.refinedSource === "fallback"
                ? h("span", { style: { fontSize: 10, color: tokens.danger, marginTop: 12 } }, "本地模板 · 模型不可用")
                : null,
          ),
          h("textarea", {
            value: state.refined,
            rows: 8,
            placeholder: "点「整理命令」后出现结构化提示词，发送前可以任意修改。",
            onChange: (event) => api.setRefined(event.target.value),
            style: fieldStyle(tokens),
          }),
          state.refinedWarning !== ""
            ? h("div", { style: { marginTop: 4, fontSize: 10, color: tokens.danger, lineHeight: 1.5 } }, state.refinedWarning)
            : null,

          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
            h(
              "button",
              {
                type: "button",
                disabled: !canSend,
                onClick: () => api.send(),
                style: buttonStyle(tokens, "primary", !canSend),
              },
              state.sending ? "发送中…" : "发送并执行",
            ),
            h("span", { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.4 } }, "完成后响铃提醒"),
          ),
          h(AutoApproveToggle, {
            tokens,
            api,
            feature: "prompt",
            enabled: state.autoApprove.prompt,
            hint: "该对话请求终端或工具权限时，相关的自动同意，明显不合理的自动拒绝。",
          }),

          state.tasks.length > 0 ? h("div", { style: labelStyle(tokens) }, "任务") : null,
          state.tasks.length > 0
            ? h("div", null, state.tasks.map((task) => h(TaskRow, { key: task.id, tokens, task })))
            : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * 标签页二：多任务管理员
     * ------------------------------------------------------------------ */

    const KIND_META = {
      ask: { label: "分析", hint: "只读分析" },
      implement: { label: "实施", hint: "修改代码" },
      review: { label: "复核", hint: "一致性检查" },
      scaffold: { label: "骨架", hint: "定义契约" },
      module: { label: "模块", hint: "独立实现" },
      integrate: { label: "集成", hint: "拼接联调" },
      verify: { label: "验收", hint: "检查问题" },
    }

    /** 按依赖把步骤分层：同层步骤互不依赖，可以并行。 */
    function planLayers(steps) {
      const byId = new Map(steps.map((step) => [step.id, step]))
      const level = new Map()
      function calc(id, guard) {
        if (level.has(id)) return level.get(id)
        if (guard.has(id)) return 0
        guard.add(id)
        const step = byId.get(id)
        const deps = step === undefined ? [] : step.dependsOn.filter((dep) => byId.has(dep))
        const value = deps.length === 0 ? 0 : 1 + Math.max.apply(null, deps.map((dep) => calc(dep, guard)))
        level.set(id, value)
        return value
      }
      for (const step of steps) calc(step.id, new Set())
      const layers = []
      for (const step of steps) {
        const index = level.get(step.id) || 0
        if (layers[index] === undefined) layers[index] = []
        layers[index].push(step)
      }
      return layers.filter((layer) => layer !== undefined)
    }

    function stepIndexMap(steps) {
      const map = new Map()
      steps.forEach((step, index) => map.set(step.id, index + 1))
      return map
    }

    /** 多项目计划的展示文案：每行「项目名 → 路径」。 */
    function adProjectsLabel(projects) {
      return projects.map((item) => item.name + " → " + item.path).join("\n")
    }

    function kindColor(tokens, kind) {
      if (kind === "ask" || kind === "scaffold") return tokens.accent
      if (kind === "implement" || kind === "module") return tokens.success
      if (kind === "integrate") return "#8a63d2"
      return "#c08a2e"
    }

    function StepCard({ tokens, step, order, depsLabel, status, selected, onSelect }) {
      const color = kindColor(tokens, step.kind)
      const statusColor =
        status === "done" ? tokens.success : status === "error" ? tokens.danger : status === "running" ? tokens.accent : tokens.muted
      return h(
        "button",
        {
          type: "button",
          onClick: onSelect,
          style: {
            flex: "1 1 calc(50% - 4px)",
            minWidth: 0,
            textAlign: "left",
            padding: "7px 8px",
            borderRadius: 7,
            border: "1px solid " + (selected ? tokens.accent : tokens.border),
            background: selected ? tokens.hover : tokens.panelAlt,
            color: tokens.text,
            cursor: "pointer",
            opacity: status === "pending" && status !== undefined ? 0.85 : 1,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 5, marginBottom: 3 } },
          h(
            "span",
            {
              style: {
                width: 15,
                height: 15,
                borderRadius: 8,
                background: color,
                color: "#fff",
                fontSize: 9,
                fontWeight: 700,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              },
            },
            String(order),
          ),
          h("span", { style: { fontSize: 9, fontWeight: 700, color, flex: "none" } }, KIND_META[step.kind] ? KIND_META[step.kind].label : step.kind),
          h("span", { style: { marginLeft: "auto", width: 6, height: 6, borderRadius: 3, background: statusColor, flex: "none" } }),
        ),
        h(
          "div",
          { style: { fontSize: 11, fontWeight: 700, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          step.title,
        ),
        h(
          "div",
          { style: { fontSize: 9, color: tokens.muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          step.project ? basename(step.project) : "",
        ),
        depsLabel ? h("div", { style: { fontSize: 9, color: tokens.muted, marginTop: 2 } }, depsLabel) : null,
      )
    }

    function PlanGraph({ tokens, plan, run, selectedStepId, onSelectStep }) {
      const layers = planLayers(plan.steps)
      const orders = stepIndexMap(plan.steps)
      const children = []
      layers.forEach((layer, layerIndex) => {
        if (layerIndex > 0) {
          children.push(
            h(
              "div",
              { key: "connector-" + layerIndex, style: { display: "flex", justifyContent: "center", padding: "2px 0" } },
              h("div", { style: { width: 1, height: 10, background: tokens.border } }),
            ),
          )
        }
        children.push(
          h(
            "div",
            { key: "layer-" + layerIndex, style: { display: "flex", flexWrap: "wrap", gap: 6 } },
            layer.map((step) =>
              h(StepCard, {
                key: step.id,
                tokens,
                step,
                order: orders.get(step.id) || 0,
                depsLabel:
                  step.dependsOn.length === 0
                    ? ""
                    : "依赖 " + step.dependsOn.map((dep) => orders.get(dep) || dep).join("、"),
                status: run && run.stepStates ? run.stepStates[step.id] : undefined,
                selected: selectedStepId === step.id,
                onSelect: () => onSelectStep(step.id),
              }),
            ),
          ),
        )
      })
      return h("div", { style: { display: "flex", flexDirection: "column" } }, children)
    }

    function ManagedRow({ tokens, entry, alive, onRemove }) {
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 7px",
            marginBottom: 3,
            borderRadius: 6,
            border: "1px solid " + tokens.border,
            background: tokens.panelAlt,
            opacity: alive ? 1 : 0.55,
          },
        },
        h("span", {
          style: { width: 6, height: 6, borderRadius: 3, background: alive ? tokens.success : tokens.muted, flex: "none" },
        }),
        h(
          "div",
          { style: { flex: 1, minWidth: 0 } },
          h(
            "div",
            { style: { fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            entry.title || entry.id.slice(0, 12),
          ),
          h(
            "div",
            { style: { fontSize: 9, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            (entry.project ? basename(entry.project) : "未知项目") + (alive ? "" : " · 已失效"),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => onRemove(entry.id),
            title: "移出托管清单",
            style: Object.assign(iconButtonStyle(tokens), { width: 18, height: 18, fontSize: 13 }),
          },
          "×",
        ),
      )
    }

    function ManagerTab({ api, tokens, state }) {
      const manager = state.manager
      const projects = groupProjects(state.sessions)
      const alive = new Set(state.sessions.map((row) => row.id))
      const plan = manager.plan || null
      const run = manager.run || null
      const selectedStep = plan === null ? null : plan.steps.find((step) => step.id === manager.selectedStepId) || null
      const selectedOutput = selectedStep !== null && run && run.outputs ? run.outputs[selectedStep.id] : ""
      const addProject = projects.find((project) => project.path === manager.addProject) || projects[0] || null
      const addProjectSessions = addProject === null ? [] : addProject.sessions.filter((row) => !isManaged(state.managed, row.id))
      const addSession = addProjectSessions.find((row) => row.id === manager.addSessionId) || addProjectSessions[0] || null

      const planning = manager.planning
      const canPlan = state.managed.length > 0 && manager.requirement.trim() !== "" && !planning && !manager.running
      const canRun = plan !== null && plan.steps.length > 0 && !manager.running
      const configOpen = manager.showConfig !== false || plan === null

      return h(
        "div",
        { style: { padding: "4px 12px 12px" } },

        configOpen
          ? h("div", null,
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6 } },
      h("span", { style: labelStyle(tokens) }, "托管清单（" + state.managed.length + "）"),
      h("span", { style: { marginLeft: "auto", marginTop: 12, fontSize: 10, color: tokens.muted } }, "只调度这里的对话"),
    ),
    h(
      "div",
      { style: { fontSize: 10, color: tokens.muted, marginBottom: 6, lineHeight: 1.5 } },
      "多任务管理员只能操作你手工加入的对话，不会碰其他项目。先选项目，再选该项目里的对话。",
    ),

    projects.length === 0
      ? h("div", { style: { fontSize: 10, color: tokens.muted, padding: "8px 0" } }, "还没有读到会话列表，点上方「刷新」重试。")
      : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 5 } },
          h(
            "select",
            {
              value: addProject === null ? "" : addProject.path,
              onChange: (event) => api.setManagerField({ addProject: event.target.value, addSessionId: "" }),
              style: Object.assign(fieldStyle(tokens), { cursor: "pointer" }),
            },
            projects.map((project) => h("option", { key: project.path, value: project.path }, projectLabel(project, projects))),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 6 } },
            h(
              "select",
              {
                value: addSession === null ? "" : addSession.id,
                onChange: (event) => api.setManagerField({ addSessionId: event.target.value }),
                style: Object.assign(fieldStyle(tokens), { flex: 1, cursor: "pointer", opacity: addProjectSessions.length === 0 ? 0.5 : 1 }),
                disabled: addProjectSessions.length === 0,
              },
              addProjectSessions.length === 0
                ? h("option", { value: "" }, "该项目下的对话都已加入")
                : addProjectSessions.map((row) => h("option", { key: row.id, value: row.id }, row.title)),
            ),
            h(
              "button",
              {
                type: "button",
                disabled: addSession === null,
                onClick: () => api.addManaged(),
                style: buttonStyle(tokens, "primary", addSession === null),
              },
              "加入",
            ),
          ),
        ),

    state.managed.length > 0
      ? h(
          "div",
          { style: { marginTop: 6, maxHeight: 118, overflowY: "auto" } },
          state.managed.map((entry) =>
            h(ManagedRow, {
              key: entry.id,
              tokens,
              entry,
              alive: alive.has(entry.id),
              onRemove: (id) => api.removeManaged(id),
            }),
          ),
        )
      : null,

    h("div", { style: labelStyle(tokens) }, "任务说明"),
    h("textarea", {
      value: manager.requirement,
      rows: 3,
      placeholder: "例如：把 tool 项目里的搜索功能，按同样效果加到另外两个项目。可以说明哪个是源项目、要求多一致。",
      onChange: (event) => api.setManagerField({ requirement: event.target.value }),
      style: fieldStyle(tokens),
    }),

    h(
      "label",
      { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 7, fontSize: 11, color: tokens.text, cursor: "pointer" } },
      h("input", {
        type: "checkbox",
        checked: manager.includeReview,
        onChange: (event) => api.setManagerField({ includeReview: event.target.checked }),
      }),
      "计划里加入对齐复核步骤",
    ),

    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 9 } },
      h(
        "button",
        {
          type: "button",
          disabled: !canPlan,
          onClick: () => api.planFlow(),
          style: buttonStyle(tokens, "primary", !canPlan),
        },
        planning ? "生成中…" : plan === null ? "生成执行计划" : "重新生成计划",
      ),
      h("span", { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.4 } }, "先看流程图，确认后才执行"),
    ),
    h(AutoApproveToggle, {
      tokens,
      api,
      feature: "manager",
      enabled: state.autoApprove.manager,
      hint: "托管清单里的对话请求权限时自动处理，不用一直盯着。",
    }),
            )
          : h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10 } },
              h("span", { style: { flex: 1, fontSize: 10, color: tokens.muted } },
                "托管 " + state.managed.length + " 个对话 · 任务说明已填写"),
              h(
                "button",
                {
                  type: "button",
                  onClick: () => api.setManagerField({ showConfig: true }),
                  style: { appearance: "none", border: "none", background: "transparent", color: tokens.accent, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 },
                },
                "修改条件",
              ),
            ),

        manager.error !== null
          ? h(
              "div",
              {
                style: {
                  marginTop: 8,
                  padding: "7px 9px",
                  borderRadius: 6,
                  border: "1px solid " + tokens.danger,
                  background: "rgba(255,90,90,0.08)",
                  color: tokens.danger,
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                },
              },
              manager.error,
            )
          : null,

        plan !== null
          ? h(
              "div",
              { style: { marginTop: 4 } },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 6 } },
                h("span", { style: labelStyle(tokens) }, "执行流程图"),
                h("span", { style: { marginLeft: "auto", marginTop: 12, fontSize: 10, color: tokens.muted } }, plan.steps.length + " 步"),
              ),
              plan.summary !== ""
                ? h("div", { style: { fontSize: 10, color: tokens.muted, marginBottom: 6, lineHeight: 1.5 } }, plan.summary)
                : null,
              h(PlanGraph, {
                tokens,
                plan,
                run,
                selectedStepId: manager.selectedStepId,
                onSelectStep: (id) => api.selectStep(id),
              }),
              manager.planWarning
                ? h("div", { style: { fontSize: 10, color: tokens.danger, marginTop: 6, lineHeight: 1.5 } }, manager.planWarning)
                : null,

              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 9 } },
                manager.running
                  ? h(
                      "button",
                      { type: "button", onClick: () => api.stopPlan(), style: buttonStyle(tokens, "ghost", false) },
                      "停止",
                    )
                  : h(
                      "button",
                      {
                        type: "button",
                        disabled: !canRun,
                        onClick: () => api.runPlan(),
                        style: buttonStyle(tokens, "primary", !canRun),
                      },
                      manager.finished ? "再执行一次" : "确认执行",
                    ),
                h(
                  "span",
                  { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.4 } },
                  manager.running ? manager.statusText : manager.finished ? "已完成" : "并行步骤会同时发送",
                ),
              ),

              selectedStep !== null
                ? h(
                    "div",
                    { style: { marginTop: 8 } },
                    h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: 6 } },
                      h("span", { style: labelStyle(tokens) }, "步骤 " + (stepIndexMap(plan.steps).get(selectedStep.id) || "") + " · " + selectedStep.summary),
                      h(
                        "span",
                        { style: { marginLeft: "auto", marginTop: 12, fontSize: 10, color: tokens.muted } },
                        run && run.stepStates ? run.stepStates[selectedStep.id] || "待执行" : "待执行",
                      ),
                    ),
                    selectedOutput !== ""
                      ? h(
                          "pre",
                          {
                            style: Object.assign(fieldStyle(tokens), {
                              maxHeight: 140,
                              overflow: "auto",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              margin: 0,
                              fontSize: 10,
                              lineHeight: 1.5,
                            }),
                          },
                          selectedOutput,
                        )
                      : h("div", { style: { fontSize: 10, color: tokens.muted } }, "还没有输出。执行完成后这里会显示该步骤的回复。"),
                  )
                : h("div", { style: { fontSize: 10, color: tokens.muted, marginTop: 6 } }, "点流程图里的步骤，可以查看它的输出。"),

              h(LogList, { tokens, log: run && run.log ? run.log : [] }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * 标签页三：自主助理
     * ------------------------------------------------------------------ */

    function AutoTab({ api, tokens, state }) {
      const auto = state.auto
      const plan = auto.plan || null
      const run = auto.run || null
      const steps = plan === null ? [] : plan.steps
      const orders = stepIndexMap(steps)
      const selectedStep = steps.find((step) => step.id === auto.selectedStepId) || null
      const selectedOutput = selectedStep !== null && run && run.outputs ? run.outputs[selectedStep.id] : ""
      const canStart = auto.goal.trim() !== "" && !auto.planning && !auto.running
      const created = run && run.sessions ? Object.keys(run.sessions).length : 0
      const showConfirm = plan !== null && !auto.running && !auto.finished && auto.review && run === null

      return h(
        "div",
        { style: { padding: "4px 12px 12px" } },

        h("div", { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.5, marginTop: 8 } },
          "给它一个很大的目标，它自己决定要开几个对话、怎么分工。"
        ),

        h("div", { style: labelStyle(tokens) }, "要完成什么"),
        h("textarea", {
          value: auto.goal,
          rows: 5,
          placeholder: "例如：从零做一个可以玩的太空射击网页游戏；或者：参考我之前那两个 App，再做一款同风格的新 App。",
          onChange: (event) => api.setAutoField({ goal: event.target.value }),
          style: fieldStyle(tokens),
        }),

        h("div", { style: labelStyle(tokens) }, "工作目录"),
        h("input", {
          value: auto.projectRoot,
          placeholder: "默认 ~/dsh-projects（新项目会建在它下面）",
          onChange: (event) => api.setAutoField({ projectRoot: event.target.value }),
          style: fieldStyle(tokens),
        }),
        h("div", { style: { fontSize: 10, color: tokens.muted, marginTop: 3, lineHeight: 1.5 } },
          auto.projectRoot.trim() === "" ? "留空则使用 ~/dsh-projects。" : "路径已指定。"),

        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, color: tokens.text, cursor: "pointer" } },
          h("input", {
            type: "checkbox",
            checked: auto.review,
            onChange: (event) => api.setAutoField({ review: event.target.checked }),
          }),
          "执行前给我审核（先出流程图，我确认后再跑）",
        ),
        h(AutoApproveToggle, {
          tokens,
          api,
          feature: "auto",
          hint: "它新建的对话请求终端或工具权限时自动处理，自动拒绝明显不合理的请求。",
          enabled: state.autoApprove.auto,
        }),

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 9 } },
          h(
            "button",
            {
              type: "button",
              disabled: !canStart,
              onClick: () => api.startAuto(),
              style: buttonStyle(tokens, "primary", !canStart),
            },
            auto.planning
              ? "规划中…"
              : auto.running
                ? "执行中…"
                : plan === null
                  ? auto.review
                    ? "生成计划"
                    : "直接开始"
                  : "重新规划",
          ),
          h("span", { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.4 } },
            auto.review ? "先看流程图，确认后才执行" : "不审核，生成后立即执行"),
        ),

        auto.error !== null
          ? h(
              "div",
              {
                style: {
                  marginTop: 8,
                  padding: "7px 9px",
                  borderRadius: 6,
                  border: "1px solid " + tokens.danger,
                  background: "rgba(255,90,90,0.08)",
                  color: tokens.danger,
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                },
              },
              auto.error,
            )
          : null,

        plan !== null
          ? h(
              "div",
              null,
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 6 } },
                h("span", { style: labelStyle(tokens) }, "项目计划"),
                h("span", { style: { marginLeft: "auto", marginTop: 12, fontSize: 10, color: tokens.muted } }, steps.length + " 步"),
              ),
              h(
                "div",
                {
                  style: {
                    fontSize: 10,
                    color: tokens.muted,
                    lineHeight: 1.5,
                    wordBreak: "break-all",
                    whiteSpace: "pre-line",
                  },
                },
                (plan.projects || []).length === 0
                  ? ""
                  : adProjectsLabel(plan.projects),
              ),
              plan.summary !== ""
                ? h("div", { style: { fontSize: 10, color: tokens.muted, marginTop: 2, lineHeight: 1.5 } }, plan.summary)
                : null,
              h(PlanGraph, {
                tokens,
                plan,
                run,
                selectedStepId: auto.selectedStepId,
                onSelectStep: (id) => api.selectAutoStep(id),
              }),
              auto.planWarning
                ? h("div", { style: { fontSize: 10, color: tokens.danger, marginTop: 6, lineHeight: 1.5 } }, auto.planWarning)
                : null,

              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 9 } },
                auto.running
                  ? h("button", { type: "button", onClick: () => api.stopAuto(), style: buttonStyle(tokens, "ghost", false) }, "停止")
                  : showConfirm
                    ? h(
                        "button",
                        { type: "button", onClick: () => api.confirmAuto(), style: buttonStyle(tokens, "primary", false) },
                        "确认执行",
                      )
                    : auto.finished
                      ? h(
                          "button",
                          { type: "button", onClick: () => api.confirmAuto(), style: buttonStyle(tokens, "primary", false) },
                          "再执行一次",
                        )
                      : null,
                h("span", { style: { fontSize: 10, color: tokens.muted, lineHeight: 1.4 } },
                  auto.running
                    ? auto.statusText
                    : auto.finished
                      ? "已完成 · 新建了 " + created + " 个对话"
                      : showConfirm
                        ? "并行步骤会同时派给不同对话"
                        : ""),
              ),

              selectedStep !== null
                ? h(
                    "div",
                    { style: { marginTop: 8 } },
                    h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: 6 } },
                      h("span", { style: labelStyle(tokens) },
                        "步骤 " + (orders.get(selectedStep.id) || "") +
                          (selectedStep.project ? " · " + basename(selectedStep.project) : "") +
                          " · " + (selectedStep.module || selectedStep.summary)),
                      h("span", { style: { marginLeft: "auto", marginTop: 12, fontSize: 10, color: tokens.muted } },
                        run && run.stepStates ? run.stepStates[selectedStep.id] || "待执行" : "待执行"),
                    ),
                    selectedOutput !== ""
                      ? h("pre", {
                          style: Object.assign(fieldStyle(tokens), {
                            maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: 10, lineHeight: 1.5,
                          }),
                        }, selectedOutput)
                      : h("div", { style: { fontSize: 10, color: tokens.muted } }, "还没有输出。执行完成后这里会显示该对话的回复。"),
                  )
                : null,

              h(LogList, { tokens, log: run && run.log ? run.log : [] }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * 标签页四：设置
     * ------------------------------------------------------------------ */

    function SettingsTab({ api, tokens, state }) {
      const settings = state.settings

      const check = (checked, onChange, label, hint) =>
        h(
          "label",
          { style: { display: "flex", alignItems: "flex-start", gap: 6, marginTop: 7, fontSize: 11, color: tokens.text, cursor: "pointer" } },
          h("input", { type: "checkbox", checked, onChange: (event) => onChange(event.target.checked), style: { marginTop: 2 } }),
          h(
            "span",
            null,
            h("span", null, label),
            hint === "" ? null : h("span", { style: { display: "block", fontSize: 10, color: tokens.muted, lineHeight: 1.5, marginTop: 1 } }, hint),
          ),
        )

      const radio = (value, label, hint) =>
        h(
          "label",
          { style: { display: "flex", alignItems: "flex-start", gap: 6, marginTop: 6, fontSize: 11, color: tokens.text, cursor: "pointer" } },
          h("input", {
            type: "radio",
            name: "wa-notify-mode",
            checked: settings.notifyMode === value,
            onChange: () => api.setSetting("notifyMode", value),
            style: { marginTop: 2 },
          }),
          h(
            "span",
            null,
            h("span", null, label),
            h("span", { style: { display: "block", fontSize: 10, color: tokens.muted, lineHeight: 1.5, marginTop: 1 } }, hint),
          ),
        )

      return h(
        "div",
        { style: { padding: "4px 12px 12px" } },

        h("div", { style: labelStyle(tokens) }, "自动审核权限请求"),
        check(
          settings.autoApproveDefault,
          (value) => api.setSetting("autoApproveDefault", value),
          "默认打开自动审核",
          "初次使用或清除本地数据后，三个标签页的自动审核默认勾选。切换会立即应用到当前三个开关。",
        ),

        h("div", { style: labelStyle(tokens) }, "自主助理默认"),
        check(
          settings.autoReviewDefault,
          (value) => api.setSetting("autoReviewDefault", value),
          "默认勾选「执行前给我审核」",
          "新建计划时会先出流程图，等你确认。切换会立即影响自主助理页的勾选状态。",
        ),
        h("input", {
          value: settings.autoProjectRootDefault,
          placeholder: "默认工作目录（留空 = ~/dsh-projects）",
          onChange: (event) => api.setSetting("autoProjectRootDefault", event.target.value),
          style: Object.assign(fieldStyle(tokens), { marginTop: 6 }),
        }),

        h("div", { style: labelStyle(tokens) }, "步骤完成提示"),
        check(
          settings.muted,
          (value) => api.setSetting("muted", value),
          "静音（不播放提示音和朗读）",
          "勾上后仍然显示右上角横幅，只是不出声。",
        ),
        radio("sound", "只播放提示音", "每一步完成时响铃，并在右上角显示完成横幅。"),
        radio("read", "提示音后朗读完成内容", "响铃后延迟约 1.2 秒，朗读步骤标题与完成内容摘要。"),

        h(
          "div",
          {
            style: {
              marginTop: 12,
              padding: "8px 9px",
              borderRadius: 6,
              border: "1px solid " + tokens.border,
              background: tokens.panelAlt,
              fontSize: 10,
              color: tokens.muted,
              lineHeight: 1.6,
            },
          },
          h("div", { style: { fontWeight: 700, color: tokens.text, marginBottom: 3 } }, "待确认"),
          "已确认：默认只响铃；朗读只念步骤标题；提供静音开关；设置写入 DSH profile，换浏览器也生效。",
          "仍未定稿：",
          h("div", null, "1. 提示音来源与音量：浏览器现场合成的三音提示，未提供音量调节。"),
          h("div", null, "2. 横幅：右上角，9 秒后自动消失，文案为「步骤完成 + 步骤标题」。"),
          h("div", null, "3. 朗读：浏览器 speechSynthesis，语言 zh-CN，音色用系统默认。"),
          h("div", null, "4. 自主助理「默认配置项」的范围：目前只有审核开关与默认工作目录。"),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * 浮窗
     * ------------------------------------------------------------------ */

    function FloatCard({ api, tokens, state }) {
      const cardRef = React.useRef(null)
      const dragRef = React.useRef(null)

      // 首次挂载时按实测尺寸贴到右下角。
      React.useEffect(() => {
        const card = cardRef.current
        if (card === null) return
        if (api.store.get().position !== null) return
        if (api.store.get().minimized) return
        const rect = card.getBoundingClientRect()
        if (rect.height <= 0) return
        api.setPosition({
          x: Math.max(EDGE, window.innerWidth - rect.width - EDGE),
          y: Math.max(EDGE, window.innerHeight - rect.height - EDGE),
        })
      }, [])

      // 卡片尺寸变化后重新收边。
      React.useEffect(() => {
        const card = cardRef.current
        if (card === null || typeof ResizeObserver !== "function") return undefined
        const observer = new ResizeObserver(() => {
          const current = api.store.get().position
          if (current === null) return
          const rect = card.getBoundingClientRect()
          if (rect.height <= 0 || rect.width <= 0) return
          const next = clampPosition(current, rect.width, rect.height)
          if (next.x !== current.x || next.y !== current.y) api.setPosition(next)
        })
        observer.observe(card)
        return () => observer.disconnect()
      }, [state.open, state.minimized])

      // 窗口尺寸变化后把卡片拉回可视范围。
      React.useEffect(() => {
        const onResize = () => {
          const card = cardRef.current
          if (card === null) return
          const current = api.store.get().position
          if (current === null) return
          const rect = card.getBoundingClientRect()
          const next = clampPosition(current, rect.width, rect.height)
          if (next.x !== current.x || next.y !== current.y) api.setPosition(next)
        }
        window.addEventListener("resize", onResize)
        return () => window.removeEventListener("resize", onResize)
      }, [])

      if (!state.open) return null

      const height = Math.min(CARD_MAX_HEIGHT, Math.max(220, window.innerHeight - 2 * EDGE))
      const width = Math.min(CARD_WIDTH, Math.max(260, window.innerWidth - 2 * EDGE))
      const measured = cardRef.current === null ? 0 : cardRef.current.getBoundingClientRect().height
      const boundHeight = measured > 0 ? Math.min(measured, height) : height
      const position = clampPosition(state.position === null ? defaultPosition(boundHeight) : state.position, width, boundHeight)

      const beginDrag = (event) => {
        if (event.button !== 0) return
        const card = cardRef.current
        if (card === null) return
        if (event.target && event.target.closest && event.target.closest("[data-no-drag]")) return
        const rect = card.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        event.preventDefault()
        const onMove = (moveEvent) => {
          const drag = dragRef.current
          if (drag === null) return
          api.setPosition(
            clampPosition({ x: moveEvent.clientX - drag.dx, y: moveEvent.clientY - drag.dy }, rect.width, rect.height),
          )
        }
        const onUp = () => {
          dragRef.current = null
          window.removeEventListener("pointermove", onMove)
          window.removeEventListener("pointerup", onUp)
        }
        window.addEventListener("pointermove", onMove)
        window.addEventListener("pointerup", onUp)
      }

      const runningCount = state.tasks.filter((task) => task.status === "running").length + (state.manager.running ? 1 : 0)

      if (state.minimized) {
        return h(
          "div",
          {
            ref: cardRef,
            onPointerDown: beginDrag,
            style: {
              position: "fixed",
              left: position.x,
              top: position.y,
              zIndex: 2147482000,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              borderRadius: 10,
              border: "1px solid " + tokens.border,
              background: tokens.panel,
              color: tokens.text,
              boxShadow: tokens.shadow,
              fontSize: 12,
              fontWeight: 700,
              cursor: "grab",
              userSelect: "none",
            },
          },
          h("span", { style: { width: 7, height: 7, borderRadius: 4, background: runningCount > 0 ? tokens.accent : tokens.success } }),
          h("span", null, "工作助手"),
          runningCount > 0 ? h("span", { style: { color: tokens.accent, fontWeight: 700 } }, runningCount + " 个任务") : null,
          h(
            "button",
            {
              type: "button",
              "data-no-drag": true,
              onClick: () => api.restore(),
              style: Object.assign(iconButtonStyle(tokens), { width: "auto", padding: "2px 8px", fontSize: 11, fontWeight: 700, color: tokens.accent }),
              title: "展开",
            },
            "展开",
          ),
        )
      }

      return h(
        "div",
        {
          ref: cardRef,
          style: {
            position: "fixed",
            left: position.x,
            top: position.y,
            width,
            maxHeight: height,
            zIndex: 2147482000,
            display: "flex",
            flexDirection: "column",
            background: tokens.panel,
            color: tokens.text,
            border: "1px solid " + tokens.border,
            borderRadius: 12,
            boxShadow: tokens.shadow,
            overflow: "hidden",
          },
        },
        h(
          "div",
          {
            onPointerDown: beginDrag,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 10px 9px 12px",
              borderBottom: "1px solid " + tokens.border,
              cursor: "grab",
              userSelect: "none",
              flex: "none",
              touchAction: "none",
            },
          },
          h("span", { style: { width: 7, height: 7, borderRadius: 4, background: runningCount > 0 ? tokens.accent : tokens.success, flex: "none" } }),
          h("span", { style: { flex: 1, fontSize: 13, fontWeight: 700 } }, "工作助手"),
          runningCount > 0 ? h("span", { style: { fontSize: 11, color: tokens.accent, fontWeight: 700 } }, runningCount + " 个任务中") : null,
          h(
            "button",
            { type: "button", "data-no-drag": true, onClick: () => api.minimize(), style: iconButtonStyle(tokens), title: "收起" },
            "—",
          ),
          h(
            "button",
            { type: "button", "data-no-drag": true, onClick: () => api.close(), style: iconButtonStyle(tokens), title: "关闭（任务仍会在后台跟踪）" },
            "×",
          ),
        ),
        h(TabBar, { tokens, tab: state.tab, onSelect: (tab) => api.setTab(tab) }),
        h(
          "div",
          { style: { padding: "4px 0 0", overflowY: "auto", flex: 1, minHeight: 0 } },
          state.tab === "manager"
            ? h(ManagerTab, { api, tokens, state })
            : state.tab === "auto"
              ? h(AutoTab, { api, tokens, state })
              : state.tab === "settings"
                ? h(SettingsTab, { api, tokens, state })
                : h(PromptTab, { api, tokens, state }),
        ),
      )
    }

    function AssistantOverlay(props) {
      const api = props.api
      const state = React.useSyncExternalStore(api.store.subscribe, api.store.get, api.store.get)
      const dark = useDarkMode()
      const tokens = React.useMemo(() => paletteFor(dark), [dark])
      const content = h(
        React.Fragment,
        null,
        h(FloatCard, { api, tokens, state }),
        h(Toast, { tokens, toast: state.toast, onClose: () => api.dismissToast() }),
      )
      // 挂到 body：浮窗必须是视口坐标，不能被应用外壳的 transform/overflow 改基准。
      try {
        if (document.body !== null && ReactDOM && typeof ReactDOM.createPortal === "function") {
          return ReactDOM.createPortal(content, document.body)
        }
      } catch (_) {
        /* 降级为直接渲染 */
      }
      return content
    }
    function apply(ctx) {
      const store = createStore(loadPrefs())
      const disposers = []
      try {
        initThemeBridge(ctx)
      } catch (_) {
        /* 主题桥失败不影响其它功能 */
      }

      /**
       * 取一个 Remote 命名空间。
       *
       * 生成的命名空间是网关的子服务，键名形如 `remote.session`。
       * 直接写 `ctx.remote.session` 会触发 cordis 的 inject 守卫
       * （"cannot get property remote.session without inject"），
       * 而 `ctx.get()` 是原始查找、不受守卫限制；拿不到时再退回属性访问。
       */
      function remoteNamespace(name) {
        const key = "remote." + name
        if (typeof ctx.get === "function") {
          try {
            const service = ctx.get(key)
            if (service !== undefined && service !== null) return service
          } catch (_) {
            /* 继续尝试属性访问 */
          }
        }
        try {
          return ctx.remote[name]
        } catch (_) {
          return undefined
        }
      }

      async function unwrap(promiseFactory) {
        const result = await promiseFactory()
        if (result === null || result === undefined || result.ok !== true) {
          const reason = result && result.error !== undefined ? result.error : result
          throw new Error(errorMessage(reason))
        }
        return result.value
      }

      async function listSessions() {
        const session = remoteNamespace("session")
        if (session === undefined || typeof session.list !== "function") throw new Error("会话服务尚未就绪")
        const value = await unwrap(() => session.list({}))
        const items = value && Array.isArray(value.items) ? value.items : []
        return items
          .filter((row) => row && typeof row.sessionId === "string" && row.origin !== "subagent")
          .map((row) => ({
            id: row.sessionId,
            title: titleOfRow(row),
            cwd: typeof row.cwd === "string" ? row.cwd : "",
            running: row.running === true,
            blank: row.blank === true,
            updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
            asOfSeq:
              row.projections && typeof row.projections.asOfSeq === "number" ? row.projections.asOfSeq : undefined,
          }))
          .sort((left, right) => toMillis(right.updatedAt) - toMillis(left.updatedAt))
      }

      async function refreshSessions() {
        store.set({ sessionsLoading: true })
        try {
          const sessions = await listSessions()
          const state = store.get()
          const projects = groupProjects(sessions)

          // 1) 项目：当前项目还在就保留；否则跟着当前对话；再否则取最近活跃的项目。
          let projectPath = state.projectPath
          const projectExists = projectPath !== null && projects.some((project) => project.path === projectPath)
          let selectedRow = state.selectedId === null ? undefined : sessions.find((row) => row.id === state.selectedId)
          if (!projectExists) {
            if (selectedRow !== undefined) projectPath = selectedRow.cwd || ""
            else projectPath = projects.length > 0 ? projects[0].path : null
          }

          // 2) 对话：当前对话仍属于该项目就保留；否则用「固定 / 上次使用 / 最近活动」。
          const project = projects.find((candidate) => candidate.path === projectPath) || null
          let selectedId = null
          if (project !== null) {
            if (selectedRow !== undefined && (selectedRow.cwd || "") === project.path) selectedId = selectedRow.id
            else selectedId = resolveSessionFor(project, state.defaults, state.pinned)
          }

          store.set({ sessions, sessionsLoading: false, sessionsError: null, projectPath, selectedId })
          store.persist()
        } catch (error) {
          store.set({ sessionsLoading: false, sessionsError: errorMessage(error) })
        }
      }

      function notifyDone(task) {
        playChime()
        store.set({
          toast: {
            id: makeId("toast-"),
            title: "任务已完成",
            body: "「" + task.title + "」已经跑完了。",
            at: Date.now(),
          },
        })
      }

      function notify(title, body) {
        if (!store.get().settings.muted) playChime()
        store.set({ toast: { id: makeId("toast-"), title, body, at: Date.now() } })
        if (store.get().settings.muted) return
        if (store.get().settings.notifyMode === "read") {
          window.setTimeout(() => speak(title + "。" + body), 1200)
        }
      }

      /**
       * 单步完成时的提示：响铃 + 右上角横幅；
       * 设置里选了「朗读」时，铃声之后再念一遍完成内容。
       */
      function notifyStepDone(title) {
        const settings = store.get().settings
        if (!settings.muted) playChime()
        store.set({
          toast: {
            id: makeId("toast-"),
            title: "步骤完成",
            body: title,
            at: Date.now(),
          },
        })
        if (settings.muted) return
        if (settings.notifyMode !== "read") return
        window.setTimeout(() => speak(title + " 已完成。"), 1200)
      }

      function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms))
      }

      /** 调宿主上的 workAssistant 方法。 */
      async function callHost(method, payload) {
        const service = remoteNamespace("workAssistant")
        if (service === undefined || typeof service[method] !== "function") throw new Error("宿主连接尚未就绪")
        return unwrap(() => service[method](payload))
      }

      /** 读取某个会话最后一条带正文的助手回复。 */
      async function readLastAssistant(sessionId) {
        const session = remoteNamespace("session")
        if (session === undefined || typeof session.page !== "function") return ""
        const rows = await listSessions().catch(() => [])
        const row = rows.find((candidate) => candidate.id === sessionId)
        const throughSeq = row !== undefined ? row.asOfSeq : undefined
        if (typeof throughSeq !== "number") return ""
        const page = await unwrap(() =>
          session.page({
            address: { kind: "session", sessionId },
            throughSeq,
            maxMessages: 80,
          }),
        )
        const records = page && Array.isArray(page.records) ? page.records : []
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const event = records[index] && records[index].event
          if (!event || event.type !== "assistant/message") continue
          const message = event.data && event.data.message
          const content = message && Array.isArray(message.content) ? message.content : []
          const text = content
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("")
            .trim()
          if (text !== "") return text
        }
        return ""
      }

      /** 等待会话从「运行中」回到「空闲」，连续两次空闲才算结束。 */
      async function waitIdle(sessionId, token) {
        const started = Date.now()
        let sawRunning = false
        let idleStreak = 0
        while (Date.now() - started < WAIT_TIMEOUT_MS) {
          if (token && token.cancelled) return false
          const rows = await listSessions().catch(() => null)
          if (rows !== null) {
            const row = rows.find((candidate) => candidate.id === sessionId)
            if (row !== undefined) {
              if (row.running) {
                sawRunning = true
                idleStreak = 0
              } else {
                idleStreak += 1
                if ((sawRunning || Date.now() - started > 7000) && idleStreak >= 2) return true
              }
            }
          }
          await sleep(POLL_INTERVAL_MS)
        }
        return false
      }

      function timezone() {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch (_) {
          return "UTC"
        }
      }

      /** 发一条指令（不做托管校验）。 */
      async function sendPrompt(sessionId, text) {
        const session = remoteNamespace("session")
        if (session === undefined || typeof session.prompt !== "function") throw new Error("会话服务尚未就绪")
        await unwrap(() =>
          session.prompt({
            requestId: makeId("work-assistant-"),
            sessionId,
            mode: "queue",
            content: [{ type: "text", text }],
            clientTimeZone: timezone(),
          }),
        )
      }

      /** 只允许向托管清单里的会话发指令。 */
      async function sendManaged(sessionId, text) {
        if (!isManaged(store.get().managed, sessionId)) throw new Error("该对话不在托管清单里，已拒绝发送")
        await sendPrompt(sessionId, text)
      }

      let saveSettingsTimer = null

      /** 把设置写回 profile（防抖 300ms）。 */
      function persistSettings() {
        if (saveSettingsTimer !== null) window.clearTimeout(saveSettingsTimer)
        saveSettingsTimer = window.setTimeout(() => {
          saveSettingsTimer = null
          callHost("saveSettings", { settings: store.get().settings }).catch(() => {})
        }, 300)
      }

      /** 启动时从 profile 读取设置；首次没有文件就把本地设置写上去。 */
      async function loadHostSettings() {
        try {
          const value = await callHost("loadSettings", {})
          const loaded = value && value.settings
          if (!loaded) {
            persistSettings()
            return
          }
          const settings = {
            autoApproveDefault: loaded.autoApproveDefault !== false,
            autoReviewDefault: loaded.autoReviewDefault !== false,
            autoProjectRootDefault: typeof loaded.autoProjectRootDefault === "string" ? loaded.autoProjectRootDefault : "",
            notifyMode: loaded.notifyMode === "read" ? "read" : "sound",
            muted: loaded.muted === true,
          }
          store.set({ settings })
          // 这个浏览器还没有任何本地偏好时，采用 profile 里的默认值。
          if (Object.keys(loadPrefs()).length === 0) {
            store.set({
              autoApprove: {
                prompt: settings.autoApproveDefault,
                manager: settings.autoApproveDefault,
                auto: settings.autoApproveDefault,
              },
            })
            store.set({
              auto: Object.assign({}, store.get().auto, {
                review: settings.autoReviewDefault,
                projectRoot: settings.autoProjectRootDefault,
              }),
            })
            syncAutoApproval()
          }
        } catch (_) {
          /* 宿主不支持时退回本地设置 */
        }
      }

      let autoApprovalTimer = null

      /** 把「需要自动审核的会话」同步给宿主。 */
      function syncAutoApproval() {
        if (autoApprovalTimer !== null) return
        autoApprovalTimer = window.setTimeout(() => {
          autoApprovalTimer = null
          const state = store.get()
          const entries = []
          if (state.autoApprove.prompt && state.selectedId !== null) {
            entries.push({ sessionId: state.selectedId, goal: (state.refined || state.raw || "").slice(0, 800) })
          }
          if (state.autoApprove.manager) {
            for (const entry of state.managed) {
              entries.push({ sessionId: entry.id, goal: state.manager.requirement.slice(0, 800) })
            }
          }
          if (state.autoApprove.auto && state.auto.run) {
            const sessions = state.auto.run.sessions || {}
            for (const sessionId of Object.values(sessions)) {
              entries.push({ sessionId, goal: state.auto.goal.slice(0, 800) })
            }
          }
          callHost("setAutoApproval", { entries }).catch(() => {})
        }, 60)
      }

      /** 在指定目录新建一个对话。 */
      async function createSession(cwd) {
        const session = remoteNamespace("session")
        if (session === undefined || typeof session.create !== "function") throw new Error("会话服务尚未就绪")
        const value = await unwrap(() => session.create({ cwd }))
        const sessionId = value && typeof value.sessionId === "string" ? value.sessionId : ""
        if (sessionId === "") throw new Error("新建对话失败")
        return sessionId
      }

      /* ---------------- 多任务编排 ---------------- */

      let flowToken = null

      function touchManager(patch) {
        const manager = store.get().manager
        store.set({ manager: Object.assign({}, manager, patch || {}) })
      }

      function flowLog(kind, text) {
        const manager = store.get().manager
        if (!manager.run) return
        manager.run.log = manager.run.log.concat([{ id: makeId("log-"), at: Date.now(), kind, text }])
        touchManager()
      }

      function updateStep(id, status) {
        const manager = store.get().manager
        if (!manager.run) return
        manager.run.stepStates = Object.assign({}, manager.run.stepStates, { [id]: status })
        touchManager()
      }

      async function runStep(step, plan, token) {
        updateStep(step.id, "running")
        touchManager({ statusText: "执行中：" + step.title })
        flowLog("info", "开始：" + step.title)
        const memory = store.get().manager.run
        try {
          const entry = managedEntry(store.get().managed, step.sessionId) || { project: step.project, title: step.sessionId }
          const inputs = step.dependsOn.map((depId) => {
            const dep = plan.steps.find((candidate) => candidate.id === depId)
            return {
              title: dep === undefined ? depId : dep.title,
              project: dep === undefined ? "" : dep.project || "",
              reply: (memory.outputs && memory.outputs[depId]) || "",
            }
          })
          const composed = await callHost("composeStep", {
            requirement: store.get().manager.requirement,
            step: {
              title: step.title,
              kind: step.kind,
              summary: step.summary,
              targetProject: entry.project || step.project || "",
              targetTitle: entry.title || "",
            },
            inputs,
            index: plan.steps.findIndex((candidate) => candidate.id === step.id),
            total: plan.steps.length,
            sourceProject: inputs.length > 0 ? inputs[0].project : "",
          })
          if (composed.warning) flowLog("info", composed.warning)
          await sendManaged(step.sessionId, composed.prompt)
          flowLog("info", "已发送到「" + (entry.title || step.sessionId) + "」，等待完成…")
          const finished = await waitIdle(step.sessionId, token)
          if (!finished) throw new Error(token && token.cancelled ? "已停止" : "等待超时")
          const reply = await readLastAssistant(step.sessionId)
          if (reply === "") throw new Error("没有读到该步骤的回复")
          memory.outputs[step.id] = reply
          updateStep(step.id, "done")
          flowLog("ok", step.title + " 完成（" + reply.length + " 字）")
          notifyStepDone(step.title)
        } catch (error) {
          updateStep(step.id, "error")
          flowLog("error", step.title + " 失败：" + errorMessage(error))
          throw error
        }
      }

      let polling = false

      async function pollOnce() {
        if (polling) return
        const tasks = store.get().tasks
        if (!tasks.some((task) => task.status === "running")) return
        polling = true
        let rows = null
        try {
          rows = await listSessions()
        } catch (_) {
          rows = null
        } finally {
          polling = false
        }
        if (rows === null) return
        const byId = new Map(rows.map((row) => [row.id, row]))
        const now = Date.now()
        const finished = []
        const nextTasks = store.get().tasks.map((task) => {
          if (task.status !== "running") return task
          const row = byId.get(task.sessionId)
          if (row !== undefined) {
            if (row.running === true) {
              return task.sawRunning ? task : Object.assign({}, task, { sawRunning: true })
            }
            const age = now - task.startedAt
            if (task.sawRunning === true || age > 6000) {
              finished.push(task)
              return Object.assign({}, task, { status: "done", finishedAt: now })
            }
            return task
          }
          // 会话从列表里消失（被归档/删除）时不再等待。
          if (now - task.startedAt > 30000) {
            finished.push(task)
            return Object.assign({}, task, { status: "done", finishedAt: now })
          }
          return task
        })
        if (finished.length > 0) store.set({ tasks: nextTasks })
        for (const task of finished) notifyDone(task)
      }

      let pollTimer = null
      function startPolling() {
        if (pollTimer !== null) return
        pollTimer = window.setInterval(() => {
          pollOnce().catch(() => {})
        }, 3000)
      }
      disposers.push(() => {
        if (pollTimer !== null) {
          window.clearInterval(pollTimer)
          pollTimer = null
        }
      })

      let pollSoon = null
      function schedulePoll() {
        if (pollSoon !== null) return
        pollSoon = window.setTimeout(() => {
          pollSoon = null
          pollOnce().catch(() => {})
        }, 400)
      }
      disposers.push(() => {
        if (pollSoon !== null) {
          window.clearTimeout(pollSoon)
          pollSoon = null
        }
      })

      // 会话状态变化时立刻复查一次，避免等满 3 秒。
      try {
        const off = ctx.remote.$on("api-session/status", () => schedulePoll())
        if (typeof off === "function") disposers.push(off)
      } catch (_) {
        /* $on 在只读连接下不可用时忽略 */
      }

      /* ---------------- 自主助理 ---------------- */

      let autoToken = null

      function touchAuto(patch) {
        const auto = store.get().auto
        store.set({ auto: Object.assign({}, auto, patch || {}) })
      }

      function autoLog(kind, text) {
        const auto = store.get().auto
        if (!auto.run) return
        auto.run.log = auto.run.log.concat([{ id: makeId("log-"), at: Date.now(), kind, text }])
        touchAuto()
      }

      function autoUpdateStep(id, status) {
        const auto = store.get().auto
        if (!auto.run) return
        auto.run.stepStates = Object.assign({}, auto.run.stepStates, { [id]: status })
        touchAuto()
      }

      async function runAutoStep(step, plan, token) {
        autoUpdateStep(step.id, "running")
        touchAuto({ statusText: "执行中：" + step.title })
        autoLog("info", "开始：" + step.title)
        const memory = store.get().auto.run
        try {
          const planProjects = store.get().auto.plan.projects || []
          const projectDirectory = step.project || (planProjects[0] ? planProjects[0].path : "")
          let sessionId = step.sessionMode === "existing" ? step.sessionId : ""
          if (sessionId === "") {
            sessionId = memory.sessions[step.id] || ""
            if (sessionId === "") {
              autoLog("info", "新建对话：" + step.title)
              sessionId = await createSession(projectDirectory)
              memory.sessions[step.id] = sessionId
              touchAuto()
              syncAutoApprovalSoon()
            }
          }
          const inputs = step.dependsOn.map((depId) => {
            const dep = plan.steps.find((candidate) => candidate.id === depId)
            return {
              title: dep === undefined ? depId : dep.title,
              project: projectDirectory,
              reply: (memory.outputs && memory.outputs[depId]) || "",
            }
          })
          const composed = await callHost("composeStep", {
            requirement: store.get().auto.goal,
            step: {
              title: step.title,
              kind: step.kind,
              summary: step.summary || step.module || step.title,
              targetProject: projectDirectory,
              targetTitle: step.title,
            },
            inputs,
            index: plan.steps.findIndex((candidate) => candidate.id === step.id),
            total: plan.steps.length,
            sourceProject: "",
          })
          if (composed.warning) autoLog("info", composed.warning)
          await sendPrompt(sessionId, composed.prompt)
          autoLog("info", "已派给对话 " + sessionId.slice(-6) + "，等待完成…")
          const finished = await waitIdle(sessionId, token)
          if (!finished) throw new Error(token && token.cancelled ? "已停止" : "等待超时")
          const reply = await readLastAssistant(sessionId)
          if (reply === "") throw new Error("没有读到该步骤的回复")
          memory.outputs[step.id] = reply
          autoUpdateStep(step.id, "done")
          autoLog("ok", step.title + " 完成（" + reply.length + " 字）")
          notifyStepDone(step.title)
        } catch (error) {
          autoUpdateStep(step.id, "error")
          autoLog("error", step.title + " 失败：" + errorMessage(error))
          throw error
        }
      }

      function syncAutoApprovalSoon() {
        window.setTimeout(() => syncAutoApproval(), 0)
      }

      async function runAutoPlan() {
        const auto = store.get().auto
        const plan = auto.plan
        if (plan === null || auto.running) return
        const token = { cancelled: false }
        autoToken = token
        const stepStates = {}
        for (const step of plan.steps) stepStates[step.id] = "pending"
        const run = { log: [], stepStates, outputs: {}, sessions: {}, startedAt: Date.now() }
        touchAuto({ running: true, finished: false, error: null, statusText: "准备中", run })
        const projectPaths = (plan.projects || []).map((item) => item.path)
        autoLog("info", "开始执行：" + plan.steps.length + " 步，涉及 " + projectPaths.length + " 个项目")
        for (const directory of projectPaths) {
          try {
            await callHost("prepareProject", { directory })
          } catch (error) {
            autoLog("error", "准备工作目录失败：" + directory + " — " + errorMessage(error))
            throw error
          }
        }
        if (projectPaths.length > 0) autoLog("info", "项目目录：" + projectPaths.join("、"))
        try {
          const done = new Set()
          const remaining = new Map(plan.steps.map((step) => [step.id, step]))
          while (remaining.size > 0) {
            if (token.cancelled) throw new Error("已停止")
            const ready = Array.from(remaining.values()).filter((step) => step.dependsOn.every((dep) => done.has(dep)))
            if (ready.length === 0) throw new Error("依赖无法满足，计划可能有问题")
            await Promise.all(ready.map((step) => runAutoStep(step, plan, token)))
            for (const step of ready) {
              remaining.delete(step.id)
              done.add(step.id)
            }
          }
          touchAuto({ running: false, finished: true, statusText: "已完成" })
          autoLog("ok", "全部步骤完成")
          const names = (plan.projects || []).map((item) => item.name).filter(Boolean)
          notify(
            "自主任务已完成",
            (names.length > 0 ? "项目 " + names.join("、") + " " : "") + "的 " + plan.steps.length + " 个步骤都跑完了。",
          )
        } catch (error) {
          const stopped = token.cancelled
          touchAuto({
            running: false,
            finished: false,
            statusText: stopped ? "已停止" : "执行失败",
            error: stopped ? null : "执行失败：" + errorMessage(error),
          })
          autoLog(stopped ? "info" : "error", stopped ? "已停止后续步骤" : errorMessage(error))
        } finally {
          autoToken = null
        }
      }

      const api = {
        store,
        setSetting(key, value) {
          const allowed = ["autoApproveDefault", "autoReviewDefault", "autoProjectRootDefault", "notifyMode", "muted"]
          if (!allowed.includes(key)) return
          const settings = Object.assign({}, store.get().settings, { [key]: value })
          store.set({ settings })
          if (key === "autoApproveDefault") {
            store.set({ autoApprove: { prompt: value === true, manager: value === true, auto: value === true } })
            syncAutoApproval()
          } else if (key === "autoReviewDefault") {
            store.set({ auto: Object.assign({}, store.get().auto, { review: value === true }) })
          } else if (key === "autoProjectRootDefault") {
            store.set({ auto: Object.assign({}, store.get().auto, { projectRoot: String(value || "") }) })
          }
          store.persist()
          persistSettings()
        },

        toggleAutoApprove(feature) {
          const state = store.get()
          const autoApprove = Object.assign({}, state.autoApprove, { [feature]: !state.autoApprove[feature] })
          store.set({ autoApprove })
          store.persist()
          syncAutoApproval()
        },

        setTab(tab) {
          store.set({ tab: ["manager", "auto", "settings"].includes(tab) ? tab : "prompt" })
          store.persist()
        },

        /* ---------------- 多任务管理员 ---------------- */

        setManagerField(patch) {
          const manager = store.get().manager
          const next = Object.assign({}, manager, patch)
          if (patch.addProject !== undefined) next.addSessionId = ""
          store.set({ manager: next })
          store.persist()
        },

        addManaged() {
          const state = store.get()
          const projects = groupProjects(state.sessions)
          const project = projects.find((candidate) => candidate.path === state.manager.addProject) || projects[0]
          if (project === undefined) return
          const candidates = project.sessions.filter((row) => !isManaged(state.managed, row.id))
          if (candidates.length === 0) return
          const row = candidates.find((candidate) => candidate.id === state.manager.addSessionId) || candidates[0]
          const managed = state.managed.concat([{ id: row.id, project: row.cwd || project.path, title: row.title }])
          syncAutoApprovalSoon()
          store.set({
            managed,
            manager: Object.assign({}, state.manager, {
              addSessionId: "",
              plan: null,
              run: null,
              error: null,
              selectedStepId: null,
              planWarning: "",
            }),
          })
          store.persist()
        },

        removeManaged(id) {
          const state = store.get()
          const managed = state.managed.filter((entry) => entry.id !== id)
          syncAutoApprovalSoon()
          store.set({
            managed,
            manager: Object.assign({}, state.manager, {
              plan: null,
              run: null,
              error: null,
              selectedStepId: null,
              planWarning: "",
            }),
          })
          store.persist()
        },

        selectStep(id) {
          touchManager({ selectedStepId: id })
        },

        async planFlow() {
          const state = store.get()
          const manager = state.manager
          if (state.managed.length === 0) {
            touchManager({ error: "先把要管理的对话加入托管清单" })
            return
          }
          if (manager.requirement.trim() === "") {
            touchManager({ error: "先写任务说明" })
            return
          }
          touchManager({ planning: true, error: null, planWarning: "", plan: null, run: null, selectedStepId: null })
          try {
            const value = await callHost("planFlow", {
              requirement: manager.requirement,
              includeReview: manager.includeReview,
              conversations: state.managed.map((entry) => ({ sessionId: entry.id, project: entry.project, title: entry.title })),
            })
            const steps = Array.isArray(value && value.steps) ? value.steps : []
            if (steps.length === 0) throw new Error((value && value.warning) || "没有生成可执行的步骤")
            const allowed = new Set(state.managed.map((entry) => entry.id))
            const merged = steps.map((step) => {
              const entry = managedEntry(state.managed, step.sessionId)
              return Object.assign({}, step, { project: entry === null ? "" : entry.project })
            })
            if (merged.some((step) => !allowed.has(step.sessionId))) {
              throw new Error("计划里出现了托管清单之外的对话，已拒绝")
            }
            touchManager({
              planning: false,
              plan: { summary: (value && value.summary) || "", steps: merged },
              planWarning: (value && value.warning) || "",
              selectedStepId: merged[0] ? merged[0].id : null,
              showConfig: false,
            })
          } catch (error) {
            touchManager({ planning: false, error: "生成计划失败：" + errorMessage(error) })
          }
        },

        async runPlan() {
          const state = store.get()
          const manager = state.manager
          const plan = manager.plan
          if (plan === null || plan.steps.length === 0 || manager.running) return
          const token = { cancelled: false }
          flowToken = token
          const stepStates = {}
          for (const step of plan.steps) stepStates[step.id] = "pending"
          const run = { log: [], stepStates, outputs: {}, startedAt: Date.now() }
          touchManager({ running: true, finished: false, error: null, statusText: "准备中", run })
          flowLog("info", "开始执行，共 " + plan.steps.length + " 步")
          try {
            const done = new Set()
            const remaining = new Map(plan.steps.map((step) => [step.id, step]))
            while (remaining.size > 0) {
              if (token.cancelled) throw new Error("已停止")
              const ready = Array.from(remaining.values()).filter((step) => step.dependsOn.every((dep) => done.has(dep)))
              if (ready.length === 0) throw new Error("依赖无法满足，计划可能有问题")
              await Promise.all(ready.map((step) => runStep(step, plan, token)))
              for (const step of ready) {
                remaining.delete(step.id)
                done.add(step.id)
              }
            }
            touchManager({ running: false, finished: true, statusText: "已完成" })
            flowLog("ok", "全部步骤完成")
            notify("多任务已完成", "计划里的 " + plan.steps.length + " 个步骤都跑完了。")
          } catch (error) {
            const stopped = token.cancelled
            touchManager({
              running: false,
              finished: false,
              statusText: stopped ? "已停止" : "执行失败",
              error: stopped ? null : "执行失败：" + errorMessage(error),
            })
            flowLog(stopped ? "info" : "error", stopped ? "已停止后续步骤" : errorMessage(error))
          } finally {
            flowToken = null
          }
        },

        stopPlan() {
          if (flowToken !== null) flowToken.cancelled = true
          touchManager({ statusText: "正在停止…" })
        },

        /* ---------------- 自主助理 ---------------- */

        setAutoField(patch) {
          const auto = store.get().auto
          store.set({ auto: Object.assign({}, auto, patch) })
          store.persist()
        },

        selectAutoStep(id) {
          touchAuto({ selectedStepId: id })
        },

        async startAuto() {
          const auto = store.get().auto
          const goal = auto.goal.trim()
          if (goal === "") {
            touchAuto({ error: "先写清楚要做什么" })
            return
          }
          touchAuto({
            planning: true,
            error: null,
            plan: null,
            planWarning: "",
            run: null,
            selectedStepId: null,
            finished: false,
            statusText: "",
          })
          try {
            const value = await callHost("planProject", {
              goal,
              projectRoot: auto.projectRoot.trim(),
              sessions: store.get().sessions.map((row) => ({ sessionId: row.id, project: row.cwd, title: row.title })),
            })
            const steps = Array.isArray(value && value.steps) ? value.steps : []
            if (steps.length === 0) throw new Error((value && value.warning) || "没有生成可执行的步骤")
            const projects = Array.isArray(value.projects) ? value.projects : []
            const plan = {
              summary: (value && value.summary) || "",
              projects,
              steps,
            }
            touchAuto({
              planning: false,
              plan,
              planWarning: (value && value.warning) || "",
              selectedStepId: steps[0].id,
            })
            if (!store.get().auto.review) await runAutoPlan()
          } catch (error) {
            touchAuto({ planning: false, error: "生成计划失败：" + errorMessage(error) })
          }
        },

        async confirmAuto() {
          await runAutoPlan()
        },

        stopAuto() {
          if (autoToken !== null) autoToken.cancelled = true
          touchAuto({ statusText: "正在停止…" })
        },
        toggle() {
          const state = store.get()
          const nextOpen = !state.open
          store.set({ open: nextOpen, minimized: nextOpen ? false : state.minimized })
          store.persist()
          if (nextOpen) {
            refreshSessions()
            ensureAudio()
          }
        },
        close() {
          store.set({ open: false })
          store.persist()
        },
        restore() {
          store.set({ open: true, minimized: false })
          store.persist()
          refreshSessions()
        },
        minimize() {
          store.set({ minimized: true })
          store.persist()
        },
        dismissToast() {
          store.set({ toast: null })
        },
        setPosition(position) {
          store.set({ position })
          store.persist()
        },
        selectProject(path) {
          const state = store.get()
          const projects = groupProjects(state.sessions)
          const project = projects.find((candidate) => candidate.path === path) || null
          const selectedId = resolveSessionFor(project, state.defaults, state.pinned)
          store.set({ projectPath: path === "" ? null : path, selectedId, error: null })
          store.persist()
        },
        selectSession(id) {
          window.setTimeout(() => syncAutoApproval(), 0)
          const state = store.get()
          const projects = groupProjects(state.sessions)
          const row = state.sessions.find((candidate) => candidate.id === id)
          const projectPath = row !== undefined ? row.cwd || "" : state.projectPath
          const defaults = Object.assign({}, state.defaults)
          if (row !== undefined && projectPath !== null) defaults[projectPath] = id
          store.set({ selectedId: id === "" ? null : id, projectPath, defaults, error: null })
          store.persist()
        },
        /** 把当前对话固定为该项目的默认；再点一次取消固定。 */
        togglePin() {
          const state = store.get()
          if (state.projectPath === null || state.selectedId === null) return
          const pinned = Object.assign({}, state.pinned)
          if (pinned[state.projectPath] === state.selectedId) delete pinned[state.projectPath]
          else pinned[state.projectPath] = state.selectedId
          store.set({ pinned })
          store.persist()
        },
        setRaw(value) {
          store.set({ raw: value })
        },
        setRefined(value) {
          store.set({ refined: value })
        },
        refreshSessions,
        async refine() {
          const state = store.get()
          if (state.raw.trim() === "" || state.refining) return
          const assistant = remoteNamespace("workAssistant")
          if (assistant === undefined || typeof assistant.refine !== "function") {
            store.set({ error: "宿主连接尚未就绪，请稍后再试" })
            return
          }
          const selected = state.sessions.find((row) => row.id === state.selectedId)
          ensureAudio()
          store.set({ refining: true, error: null })
          try {
            const value = await unwrap(() =>
              assistant.refine({
                raw: state.raw,
                project: selected !== undefined ? selected.cwd || selected.title : "",
              }),
            )
            const prompt = value && typeof value.prompt === "string" ? value.prompt : ""
            if (prompt.trim() === "") throw new Error("模型没有返回内容")
            store.set({
              refined: prompt,
              refinedSource: value && value.source === "model" ? "model" : "fallback",
              refinedWarning: value && typeof value.warning === "string" ? value.warning : "",
              refining: false,
            })
          } catch (error) {
            store.set({ refining: false, error: "整理失败：" + errorMessage(error) })
          }
        },
        async send() {
          const state = store.get()
          if (state.sending) return
          if (state.selectedId === null) {
            store.set({ error: "请先选择一个会话" })
            return
          }
          if (state.refined.trim() === "") {
            store.set({ error: "整理结果为空" })
            return
          }
          const selected = state.sessions.find((row) => row.id === state.selectedId)
          const text = state.refined
          const session = remoteNamespace("session")
          if (session === undefined || typeof session.prompt !== "function") {
            store.set({ error: "会话服务尚未就绪，请稍后再试" })
            return
          }
          ensureAudio()
          store.set({ sending: true, error: null })
          try {
            await unwrap(() =>
              session.prompt({
                requestId: makeId("work-assistant-"),
                sessionId: state.selectedId,
                mode: "queue",
                content: [{ type: "text", text }],
                clientTimeZone: timezone(),
              }),
            )
            const task = {
              id: makeId("task-"),
              sessionId: state.selectedId,
              title: selected !== undefined ? selected.title : String(state.selectedId).slice(0, 8),
              startedAt: Date.now(),
              sawRunning: false,
              status: "running",
            }
            // 发送成功后清空两个输入框，避免同一条命令被误发第二次。
            // 发送失败时保留原内容，方便直接重试。
            store.set({
              sending: false,
              tasks: [task].concat(store.get().tasks),
              raw: "",
              refined: "",
              refinedSource: "",
              refinedWarning: "",
            })
            startPolling()
            schedulePoll()
            syncAutoApproval()
          } catch (error) {
            store.set({ sending: false, error: "发送失败：" + errorMessage(error) })
          }
        },
      }

      ctx.effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (_) {
            /* 单个清理失败不影响其它清理 */
          }
        }
      }, "work-assistant.cleanup")

      // 挂载 Remote 命名空间。失败时浮窗仍可用（只影响「整理命令」）。
      ctx.remote
        .$mount(remoteContribution)
        .then((disposeRemote) => {
          if (typeof disposeRemote === "function") disposers.push(disposeRemote)
        })
        .catch((error) => {
          console.error("[work-assistant] 挂载 Remote 失败：", error)
          store.set({ error: "工作助手未连上宿主：" + errorMessage(error) })
        })

      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "work-assistant-open", order: 60, inject: () => ({ api }) }, AssistantButton),
      )
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "work-assistant-float", inject: () => ({ api }) }, AssistantOverlay),
      )

      // 浮窗默认就在，先把会话列表拿出来。session 命名空间由 api-remotes
      // 异步挂载，启动早期可能还不在，这里轮询等待最多约 10 秒。
      let bootTries = 0
      const boot = () => {
        const session = remoteNamespace("session")
        const ready = session !== undefined && typeof session.list === "function"
        if (!ready) {
          if (bootTries++ < 40) window.setTimeout(boot, 250)
          else store.set({ sessionsError: "会话服务尚未就绪，点右上角「刷新」重试" })
          return
        }
        refreshSessions()
        window.setTimeout(() => syncAutoApproval(), 500)
        window.setTimeout(() => loadHostSettings(), 900)
      }
      boot()
    }


    exports.apply = apply
    exports.inject = ["remote", "slots"]
    return module.exports
  },
})
