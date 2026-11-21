'use strict'

/**
 * 工作助手 —— Host 半侧。
 *
 * 职责：
 *  1. refine        把用户口述命令整理成结构化提示词（基础提示词工程标签页）
 *  2. planFlow      把复杂目标拆成一张可执行的工作流（多任务管理员标签页）
 *  3. composeStep   在执行某一步时，结合前置步骤的真实输出生成该步指令
 *  4. ping          连通性自检
 *
 * 设计约束：
 *  - 不 import 任何 @deepseek-ai/* 包。profile 的 node_modules 可能是失效软链，
 *    零外部依赖保证插件在任何环境都能被加载。
 *  - Remote 暴露走 Typert Gateway 的源码回退通道：只要在服务原型上放一份
 *    `@deepseek-ai/dsh-typert-protocol/remote-methods` 标记，Gateway 会按方法
 *    签名自动推导参数。
 *  - 模型失败时必须降级，不能让按钮变成死按钮。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Typert Gateway 读取的服务方法标记属性名。 */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

const SERVICE_KEY = 'workAssistant'

/* -------------------------------------------------------------------------- *
 * 基础提示词工程
 * -------------------------------------------------------------------------- */

const REFINE_INSTRUCTIONS = [
  '你是一名资深提示词工程师。你的唯一任务：把用户写给某个 AI 编程/设计助手的一段原始命令，',
  '整理成一份结构化、无歧义、可以直接执行的中文指令。',
  '',
  '【最高优先级：忠实】',
  '1. 必须完整保留原始命令里的所有意图、对象、数量、技术栈、限制、交付要求。',
  '2. 禁止新增用户没有提出的功能、技术选型、数值指标或验收标准。',
  '3. 禁止删减用户明确提出的任何要求，包括语气里的强调。',
  '4. 信息不足时，写「- 待确认：<具体问题>」，不要自行假设成确定事实。',
  '5. 不要改变用户的语言（用户用中文就用中文）。',
  '',
  '【输出格式】',
  '只输出下面 7 个 Markdown 二级标题段落本身，不要任何开场白、解释、总结或代码围栏。',
  '标题顺序固定，且必须全部出现：',
  '#role',
  '#goal',
  '#context',
  '#output',
  '#constraints',
  '#workflow',
  '#acceptance',
  '',
  '各段落要求：',
  '- #role：一句话点明执行者身份与所需专业能力。',
  '- #goal：一句话说清最终要达成什么，动词开头。',
  '- #context：已知背景、输入材料、项目现状；确实没有就写「无特别要求」。',
  '- #output：交付物形态（文件类型、路径、目录结构、是否可直接运行），必须可验收。',
  '- #constraints：硬约束（技术栈、禁止事项、兼容性、性能、安全、风格）。',
  '- #workflow：3-7 步执行计划，每步都能验证。',
  '- #acceptance：3-5 条验收标准，逐条可以判定通过或不通过。',
].join('\n')

/* -------------------------------------------------------------------------- *
 * 多任务管理员
 * -------------------------------------------------------------------------- */

const PLAN_INSTRUCTIONS = [
  '你是一名「多任务管理员」，负责把一个复杂目标拆成一条可以在多个既有对话之间执行的工作流。',
  '',
  '你只能使用下面列出的对话（sessionId 必须原样照抄，禁止编造不存在的 id）：',
  '{conversations}',
  '',
  '用户目标：',
  '{requirement}',
  '',
  '拆分规则：',
  '1. 需要先从某个对话获取信息（例如「这个功能是怎么实现的」）时，用 kind="ask"。',
  '2. 需要某个对话动手改代码时，用 kind="implement"。',
  '3. 后一步需要用到前一步的输出时，把前一步的 id 填进 dependsOn。',
  '4. 互不依赖的步骤会并行执行；不要把有先后依赖的步骤并列。',
  '5. 多个 implement 步骤要求效果一致时，必须让它们依赖同一个 ask 分析步骤（或同一个中间步骤），',
  '   这样才能把同一份实现说明喂给每个实施步骤。',
  '{reviewRule}',
  '7. 步骤总数控制在 2-6 个，只做和目标直接相关的事。',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码围栏：',
  '{',
  '  "summary": "一句话说明这条工作流要做什么",',
  '  "steps": [',
  '    {',
  '      "id": "s1",',
  '      "title": "简短标题",',
  '      "kind": "ask",',
  '      "sessionId": "上面列出的某个 sessionId",',
  '      "summary": "这一步要做什么（给人看的一句话）",',
  '      "dependsOn": []',
  '    }',
  '  ]',
  '}',
].join('\n')

const STEP_INSTRUCTIONS = [
  '你是一名资深提示词工程师，正在为一条多项目协作工作流生成「其中一步」的可执行指令。',
  '',
  '这一步的信息：',
  '- 类型：{kind}',
  '- 标题：{title}',
  '- 要做什么：{summary}',
  '- 目标项目：{targetProject}',
  '- 目标对话标题：{targetTitle}',
  '- 这是第 {index} / {total} 步',
  '',
  '整个任务的目标：{requirement}',
  '',
  '{inputsBlock}',
  '',
  '硬性要求：',
  '1. 必须使用 `#role` / `#goal` / `#context` / `#output` / `#constraints` / `#workflow` / `#acceptance` 七段式结构，',
  '   顺序固定，全部出现。',
  '2. 类型是 ask 时：要求对方只做只读分析，讲清文件、接口、关键代码与实现步骤，不要改文件。',
  '3. 类型是 scaffold 时：要求对方只搭骨架——目录结构、入口文件、接口契约、数据结构、依赖清单，',
  '   不实现完整业务逻辑，并把契约明确写出来，供后续模块遵守。',
  '4. 类型是 module 时：只允许改本步骤 module 字段声明的文件/目录范围，严禁改其他模块的文件；',
  '   必须严格遵守前置步骤给出的接口契约；不要扩大范围。',
  '5. 类型是 integrate 时：把已有模块拼起来，补入口/路由/配置/联调，修复接口不一致，不要重写模块。',
  '6. 类型是 implement 时：把上面「前置步骤的真实输出」当作统一实现依据，要求目标项目严格按同样的命名、',
  '   目录、接口和数据结构实现，保证和其他项目效果一致；不要扩大范围。',
  '7. 类型是 review 或 verify 时：要求对方对比/验收实现结果，指出问题并给出具体修正建议，不要大改代码。',
  '8. 不确定的地方写「- 待确认：…」，不要编造。',
  '9. 只输出指令本身，不要任何解释、开场白或代码围栏。',
].join('\n')

const PROJECT_PLAN_INSTRUCTIONS = [
  '你是一名「全自主项目负责人」，要把一个复杂目标拆成可以在多个对话之间并行推进的工作流。',
  '你同时管理多个项目，也可以只用一个项目。',
  '',
  '用户目标：',
  '{goal}',
  '',
  '新建项目的根目录（新建目录必须放在它下面）：',
  '{projectRoot}',
  '',
  '{existingBlock}',
  '',
  '拆分规则：',
  '1. 先判断这个目标涉及几个项目。目标里点名了已有项目，就用那个项目现有的目录和对话；',
  '   需要从零开始的部分，才在根目录下新建项目目录。',
  '2. 第一步通常是 kind="scaffold"：搭好骨架，定义目录结构、接口契约、数据结构与模块边界。',
  '   如果目标只是给已有项目加功能，也可以跳过 scaffold 直接从 module 开始。',
  '3. 每个 kind="module" 步骤负责一个**互不重叠**的模块或文件范围，并在 module 字段写清它独占的文件/目录。',
  '   并行模块绝不能改同一批文件。',
  '4. 需要「多个项目效果一致」时，让这些项目的步骤依赖同一个分析或骨架步骤，拿到同一份依据。',
  '5. 必须有一个 kind="integrate" 步骤，依赖相关 module 步骤，负责拼接与联调（多项目时可以是跨项目核对）。',
  '6. 建议最后有一个 kind="verify" 步骤，依赖 integrate，负责验收并给出问题清单。',
  '7. 除 scaffold / module / integrate / verify 外不要用其他 kind。',
  '8. 每个步骤都要写 project 字段（该步骤所属项目的绝对路径）。',
  '9. sessionMode：需要新开对话写 "new"；复用已有对话写 "existing" 并给出该对话的 sessionId。',
  '   目标里点名的、或已有对话明显就是这个项目的主对话时，优先复用；其余用 "new"。',
  '10. 步骤总数 3-8 个，不要为了凑数拆出无意义的步骤。',
  '',
  '输出要求：只输出一个 JSON 对象，不要解释、不要代码围栏：',
  '{',
  '  "summary": "一句话说明整体方案",',
  '  "projects": [',
  '    { "name": "项目名", "path": "项目绝对路径" }',
  '  ],',
  '  "steps": [',
  '    {',
  '      "id": "s1",',
  '      "title": "简短标题",',
  '      "kind": "scaffold",',
  '      "project": "该项目绝对路径",',
  '      "sessionMode": "new",',
  '      "sessionId": "仅 sessionMode=existing 时填写",',
  '      "module": "负责的文件/目录范围",',
  '      "summary": "这一步要做什么（给人看的一句话）",',
  '      "dependsOn": []',
  '    }',
  '  ]',
  '}',
].join('\n')

/* -------------------------------------------------------------------------- *
 * 设置持久化
 * -------------------------------------------------------------------------- */

/**
 * 设置文件位置：优先当前 profile 目录，其次 DSH 用户目录。
 * 放在 profile 里意味着换浏览器、清缓存都不会丢。
 */
function settingsFilePath() {
  const env = process.env.DSH_PROFILE_DIR
  if (typeof env === 'string' && env !== '') return path.join(env, 'work-assistant.settings.json')
  const fromArgv = process.argv.find(
    (item) => typeof item === 'string' && /[\\/]profiles[\\/][^\\/]+$/.test(item),
  )
  if (fromArgv !== undefined) return path.join(fromArgv, 'work-assistant.settings.json')
  return path.join(os.homedir(), '.dsh', 'work-assistant.settings.json')
}

/* -------------------------------------------------------------------------- *
 * 通用工具
 * -------------------------------------------------------------------------- */

/**
 * 给服务原型打上 Remote 标记。等价于 TypeScript 的 `@Remote` 装饰器。
 */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(method => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  })
}

/** 取一个安全的字符串。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 去掉模型可能包上的代码围栏和客套话。 */
function cleanAnswer(text) {
  let value = String(text ?? '').trim()
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(value)
  if (fenced) value = fenced[1].trim()
  const start = value.indexOf('#role')
  if (start > 0) value = value.slice(start).trim()
  return value
}

/** 结构化结果是否可用：必须包含三个必备段落。 */
function looksStructured(text) {
  if (typeof text !== 'string' || text.trim().length < 40) return false
  return /#role/i.test(text) && /#goal/i.test(text) && /#output/i.test(text)
}

/** 工作流步骤要求七段齐全。 */
function looksFullStructured(text) {
  if (!looksStructured(text)) return false
  return ['#context', '#constraints', '#workflow', '#acceptance'].every((heading) => text.includes(heading))
}

/** 从模型输出里宽松地取出一个 JSON 对象。 */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  let value = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value)
  if (fenced) value = fenced[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(value.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch (_) {
    return undefined
  }
}

/** 生成选项：兼容不同 DSH 版本的 llm.stream 入参。 */
function buildRequest(selection, text) {
  return {
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }
}

/** 读取一个成功 finish 之外的原因描述。 */
function finishFailure(reason) {
  if (!reason || typeof reason !== 'object') return undefined
  if (reason.kind === 'stop' || reason.kind === 'length' || reason.kind === 'tool-calls') return undefined
  if (reason.kind === 'aborted') return '模型调用被取消'
  const failure = reason.failure
  if (failure && typeof failure === 'object') {
    return typeof failure.message === 'string' ? failure.message : JSON.stringify(failure)
  }
  return typeof reason.kind === 'string' ? `模型调用失败：${reason.kind}` : undefined
}

/** 调一次模型并返回原始文本。失败时抛出，由调用方决定降级。 */
async function generate(ctx, text, signal) {
  const selection = ctx.agentDefaultModel.currentSelection()
  const stream = ctx.llm.stream(buildRequest(selection, text))
  let answer = ''
  let failure
  for await (const chunk of stream) {
    if (signal?.aborted) throw new Error('已取消')
    if (chunk?.type === 'text-delta') answer += chunk.text ?? ''
    else if (chunk?.type === 'finish') failure = finishFailure(chunk.reason)
  }
  if (failure) throw new Error(failure)
  return answer
}

/** 本地兜底拼装：模型不可用时仍然产出一份结构正确的提示词。 */
function fallbackPrompt(raw, project) {
  const command = String(raw ?? '').trim()
  const place = project ? `项目「${project}」` : '当前项目'
  return [
    '#role',
    '你是一位经验丰富的执行型助手，擅长在明确的约束下独立完成工程任务。',
    '',
    '#goal',
    `在${place}中完成用户交代的任务：${command}`,
    '',
    '#context',
    `用户选择的项目：${project || '未指定'}`,
    '',
    '下面是用户的原始命令，请以它为准，不要扩大范围：',
    '"""',
    command,
    '"""',
    '',
    '#output',
    '按原始命令要求的形态交付；原始命令没有写明时，交付可直接使用/运行的成品，并说明产物位置。',
    '',
    '#constraints',
    '- 严格遵照原始命令，不新增需求，不擅自替换技术栈。',
    '- 原始命令里未明确的信息不要臆造，先按最保守的合理默认执行并在结果中说明。',
    '- 改动集中在任务范围内，不做无关重构。',
    '',
    '#workflow',
    '1. 复述并确认任务边界。',
    '2. 检查现有代码与依赖，确定改动点。',
    '3. 实现。',
    '4. 自测并修复问题。',
    '5. 汇报产物位置与使用方式。',
    '',
    '#acceptance',
    '1. 原始命令中的每一项要求都有对应实现。',
    '2. 产物可被直接打开或运行。',
    '3. 没有引入原始命令之外的功能或依赖。',
  ].join('\n')
}

/** 校验并清洗模型返回的工作流计划。 */
function normalizePlan(parsed, allowedIds) {
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : []
  const cleaned = []
  const seen = new Set()
  for (const raw of steps) {
    const id = str(raw?.id).trim()
    const title = str(raw?.title).trim()
    const kind = str(raw?.kind).trim()
    const sessionId = str(raw?.sessionId).trim()
    if (id === '' || title === '') continue
    if (seen.has(id)) continue
    if (kind !== 'ask' && kind !== 'implement' && kind !== 'review') continue
    if (!allowedIds.has(sessionId)) continue
    seen.add(id)
    cleaned.push({
      id,
      title,
      kind,
      sessionId,
      summary: str(raw?.summary).trim(),
      dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(item => str(item)).filter(item => item !== '') : [],
    })
  }
  // 依赖只保留存在的、且不指向自己
  const ids = new Set(cleaned.map(step => step.id))
  for (const step of cleaned) {
    step.dependsOn = [...new Set(step.dependsOn)].filter(id => id !== step.id && ids.has(id))
  }
  // 检测环
  const state = new Map()
  function visit(id) {
    const current = state.get(id)
    if (current === 'doing') return false
    if (current === 'done') return true
    state.set(id, 'doing')
    const step = cleaned.find(item => item.id === id)
    for (const dep of step ? step.dependsOn : []) {
      if (!visit(dep)) return false
    }
    state.set(id, 'done')
    return true
  }
  for (const step of cleaned) {
    if (!visit(step.id)) return { steps: [], error: '计划里存在循环依赖' }
  }
  return {
    summary: str(parsed?.summary).trim(),
    steps: cleaned,
  }
}

/** 清洗「自主助理」返回的多项目计划。 */
function normalizeProjectPlan(parsed, options) {
  const root = path.resolve(options.projectRoot)
  const allowedExisting = options.allowedExisting
  const existingCwds = options.existingCwds || new Map()
  const allowedDirs = options.allowedDirs || new Set()
  const kinds = new Set(['scaffold', 'module', 'integrate', 'verify'])

  /** 目录是否可用：根目录之下，或某个已有对话所在的目录。 */
  function allowDirectory(candidate) {
    const dir = path.resolve(candidate)
    if (dir === root || dir.startsWith(root + path.sep)) return dir
    if (allowedDirs.has(dir)) return dir
    return undefined
  }

  /** 给一个不可用的路径兜底：放到根目录下。 */
  function fallbackDirectory(candidate) {
    const base = path.basename(String(candidate || '').trim()) || 'dsh-project'
    return path.join(root, base.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-') || 'dsh-project')
  }

  const projects = new Map()
  const declaredProjects = Array.isArray(parsed?.projects) ? parsed.projects : []
  for (const raw of declaredProjects) {
    const rawPath = str(raw?.path).trim()
    if (rawPath === '') continue
    const dir = allowDirectory(rawPath)
    if (dir === undefined) continue
    projects.set(dir, { name: str(raw?.name).trim() || path.basename(dir), path: dir })
  }

  const steps = []
  const seen = new Set()
  for (const raw of Array.isArray(parsed?.steps) ? parsed.steps : []) {
    const id = str(raw?.id).trim()
    const title = str(raw?.title).trim()
    const kind = str(raw?.kind).trim()
    const sessionModeRaw = str(raw?.sessionMode).trim()
    const sessionMode = sessionModeRaw === 'existing' ? 'existing' : 'new'
    const sessionId = str(raw?.sessionId).trim()
    if (id === '' || title === '') continue
    if (seen.has(id)) continue
    if (!kinds.has(kind)) continue
    if (sessionMode === 'existing' && !allowedExisting.has(sessionId)) continue
    seen.add(id)

    // 项目目录：优先用步骤声明的路径；existing 步骤以会话真实目录为准。
    let projectPath = ''
    if (sessionMode === 'existing') {
      projectPath = existingCwds.get(sessionId) || ''
    }
    if (projectPath === '') {
      const declared = str(raw?.project).trim()
      projectPath = declared === '' ? '' : allowDirectory(declared) || fallbackDirectory(declared)
    }
    if (projectPath === '') projectPath = fallbackDirectory(title)
    if (!projects.has(projectPath)) {
      projects.set(projectPath, { name: path.basename(projectPath) || '项目', path: projectPath })
    }

    steps.push({
      id,
      title,
      kind,
      project: projectPath,
      sessionMode,
      sessionId: sessionMode === 'existing' ? sessionId : '',
      module: str(raw?.module).trim(),
      summary: str(raw?.summary).trim(),
      dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(item => str(item)).filter(Boolean) : [],
    })
  }

  const ids = new Set(steps.map(step => step.id))
  for (const step of steps) {
    step.dependsOn = [...new Set(step.dependsOn)].filter(id => id !== step.id && ids.has(id))
  }

  // 环检测
  const state = new Map()
  function visit(id) {
    const current = state.get(id)
    if (current === 'doing') return false
    if (current === 'done') return true
    state.set(id, 'doing')
    const step = steps.find(item => item.id === id)
    for (const dep of step ? step.dependsOn : []) {
      if (!visit(dep)) return false
    }
    state.set(id, 'done')
    return true
  }
  for (const step of steps) {
    if (!visit(step.id)) return { steps: [], error: '项目计划里存在循环依赖' }
  }

  return {
    summary: str(parsed?.summary).trim(),
    projects: Array.from(projects.values()),
    steps,
  }
}

/* -------------------------------------------------------------------------- *
 * 服务实现
 * -------------------------------------------------------------------------- */

const servicePrototype = {
  /**
   * 基础提示词工程：把原始命令整理成结构化提示词。
   * @param request `{ raw: string, project?: string }`
   * @param signal 调用方取消信号
   */
  async refine(request, signal) {
    const ctx = this.ctx
    const raw = str(request?.raw).trim()
    const project = str(request?.project).trim()
    if (raw === '') throw new Error('原始命令为空')

    const selection = ctx.agentDefaultModel.currentSelection()
    const text = [
      REFINE_INSTRUCTIONS,
      '',
      '-----',
      `用户选择的项目：${project || '未指定'}`,
      '原始命令：',
      '"""',
      raw,
      '"""',
      '',
      '现在输出整理后的指令。',
    ].join('\n')

    let answer = ''
    let failure
    try {
      answer = cleanAnswer(await generate(ctx, text, signal))
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (!failure && looksStructured(answer)) {
      return { prompt: answer, source: 'model', provider: selection.provider, model: selection.model }
    }
    return {
      prompt: fallbackPrompt(raw, project),
      source: 'fallback',
      provider: selection.provider,
      model: selection.model,
      warning: failure ?? '模型返回的内容不完整，已使用本地模板拼装。',
    }
  },

  /**
   * 多任务管理员：把目标拆成依赖明确的工作流。
   * @param request `{ requirement, conversations: [{sessionId, project, title}], includeReview }`
   */
  async planFlow(request, signal) {
    const ctx = this.ctx
    const requirement = str(request?.requirement).trim()
    const conversations = Array.isArray(request?.conversations) ? request.conversations : []
    const includeReview = request?.includeReview !== false
    if (requirement === '') throw new Error('任务说明为空')
    const usable = conversations
      .map(item => ({
        sessionId: str(item?.sessionId),
        project: str(item?.project),
        title: str(item?.title),
      }))
      .filter(item => item.sessionId !== '')
    if (usable.length === 0) throw new Error('托管清单里没有可用的对话')

    const allowedIds = new Set(usable.map(item => item.sessionId))
    const conversationText = usable
      .map(item => `- sessionId=${item.sessionId} ｜ 项目=${item.project || '未知'} ｜ 标题=${item.title || '未命名'}`)
      .join('\n')

    const instruction = PLAN_INSTRUCTIONS.replace('{conversations}', conversationText)
      .replace('{requirement}', requirement)
      .replace(
        '{reviewRule}',
        includeReview
          ? '6. 最后必须有一个 kind="review" 步骤，依赖所有 implement 步骤，用于检查各项目实现是否一致。'
          : '6. 不需要专门的复核步骤。',
      )

    let text = ''
    let warning
    try {
      text = await generate(ctx, instruction, signal)
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error)
    }

    let parsed = parseJsonLoose(text)
    if (parsed === undefined && text.trim() !== '') {
      // 再试一次，明确要求只输出 JSON
      try {
        const retry = instruction + '\n\n上一次输出无法解析。请只输出一个合法的 JSON 对象，不要任何其他文字。'
        text = await generate(ctx, retry, signal)
        parsed = parseJsonLoose(text)
      } catch (_) {
        parsed = undefined
      }
    }
    if (parsed === undefined) {
      return {
        steps: [],
        summary: '',
        warning: warning ?? '模型没有返回可解析的计划',
        raw: cleanAnswer(text).slice(0, 2000),
      }
    }

    const normalized = normalizePlan(parsed, allowedIds)
    if (normalized.error !== undefined) {
      return { steps: [], summary: '', warning: normalized.error, raw: text.slice(0, 2000) }
    }
    if (normalized.steps.length === 0) {
      return { steps: [], summary: '', warning: '模型返回的计划里没有可用步骤', raw: text.slice(0, 2000) }
    }
    return {
      summary: normalized.summary,
      steps: normalized.steps,
      warning,
      ...(warning ? {} : {}),
    }
  },

  /**
   * 为工作流中的某一步生成最终指令，可携带前置步骤的真实输出。
   * @param request `{ requirement, step, inputs: [{title, project, reply}], sourceProject }`
   */
  async composeStep(request, signal) {
    const ctx = this.ctx
    const requirement = str(request?.requirement).trim()
    const step = request?.step ?? {}
    const inputs = Array.isArray(request?.inputs) ? request.inputs : []
    const kind = str(step.kind) || 'implement'
    const title = str(step.title) || '工作流步骤'
    const summary = str(step.summary) || title
    const targetProject = str(step.targetProject) || '目标项目'
    const targetTitle = str(step.targetTitle) || ''
    const index = typeof request?.index === 'number' ? request.index : 0
    const total = typeof request?.total === 'number' ? request.total : 1
    const sourceProject = str(request?.sourceProject)

    const inputsBlock = inputs.length === 0
      ? '前置步骤的真实输出：无（这是起点步骤，没有可依赖的材料）。'
      : [
          '前置步骤的真实输出（这是事实依据，必须遵守）：',
          ...inputs.map((item, position) => [
            `【${position + 1}. ${str(item?.title) || '前置步骤'}｜项目：${str(item?.project) || '未知'}】`,
            '"""',
            str(item?.reply).trim() || '（没有可用的输出）',
            '"""',
          ].join('\n')),
        ].join('\n\n')

    const instruction = STEP_INSTRUCTIONS.replace('{kind}', kind)
      .replace('{title}', title)
      .replace('{summary}', summary)
      .replace('{targetProject}', targetProject)
      .replace('{targetTitle}', targetTitle)
      .replace('{index}', String(index + 1))
      .replace('{total}', String(total))
      .replace('{requirement}', requirement || '（未填写）')
      .replace('{inputsBlock}', inputsBlock)
      .replace('{sourceProject}', sourceProject || '（未指定）')

    let prompt = ''
    let warning
    try {
      prompt = cleanAnswer(await generate(ctx, instruction, signal))
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error)
    }
    if (!looksFullStructured(prompt)) {
      const kindRole =
        kind === 'ask'
          ? '你是一位只读的实现分析师，负责把现有功能的实现方式讲清楚。'
          : kind === 'scaffold'
            ? '你是一位架构师，负责搭好项目骨架并定义清晰的接口契约。'
            : kind === 'module'
              ? '你是一位模块实现工程师，只负责自己被划定的那部分文件。'
              : kind === 'integrate'
                ? '你是一位集成工程师，负责把已完成的模块拼成可运行的整体。'
                : kind === 'review' || kind === 'verify'
                  ? '你是一致性复核员，负责验收实现并指出问题。'
                  : '你是一位资深工程师，负责在目标项目中按统一口径实现功能。'
      const reference = inputs.length === 0 ? '' : [
        '',
        '#context',
        `- 目标项目：${targetProject}`,
        sourceProject ? `- 源项目：${sourceProject}` : '',
        '- 必须遵守下面这些前置事实：',
        ...inputs.map(item => [`【${str(item?.title) || '前置步骤'}】`, str(item?.reply).trim()].join('\n')),
      ].filter(line => line !== '').join('\n')
      prompt = [
        '#role',
        kindRole,
        '',
        '#goal',
        summary,
        reference,
        '',
        '#output',
        kind === 'ask'
          ? '按「功能概述 / 涉及文件 / 关键实现 / 实现步骤 / 依赖与配置 / 容易踩坑的地方 / 验收方式」输出说明。'
          : kind === 'scaffold'
            ? '输出骨架代码与一份接口契约说明（目录结构、文件职责、数据结构、接口签名）。'
            : kind === 'review' || kind === 'verify'
              ? '输出验收结论、问题清单与修正建议。'
              : '给出可运行的代码改动，并说明改了哪些文件、如何验证。',
        '',
        '#constraints',
        '- 只做本步骤要求的事，不扩大范围。',
        kind === 'module' ? '- 只改本步骤划定的文件范围，其他模块的文件一律不动。' : '',
        '- 不编造事实，不确定的写「待确认」。',
        '',
        '#workflow',
        '1. 阅读上下文。',
        '2. 执行本步骤。',
        '3. 自检并汇报。',
        '',
        '#acceptance',
        '1. 本步骤目标达成。',
        '2. 没有引入无关改动。',
      ].filter(line => line !== '').join('\n')
      warning = warning ?? '模型返回内容不完整，已使用模板生成该步指令'
    }
    return { prompt, warning }
  },

  /* ------------------------------------------------------------------ *
   * 自主助理
   * ------------------------------------------------------------------ */

  /** 准备工作目录：把 ~ 展开并递归创建，返回绝对路径。 */
  async prepareProject(request) {
    const raw = str(request?.directory).trim()
    if (raw === '') throw new Error('工作目录为空')
    const expanded =
      raw === '~'
        ? os.homedir()
        : raw.startsWith('~/')
          ? path.join(os.homedir(), raw.slice(2))
          : raw
    const directory = path.resolve(expanded)
    fs.mkdirSync(directory, { recursive: true })
    return { directory, created: true }
  },

  /**
   * 自主助理：把大目标拆成「骨架 → 并行模块 → 集成 → 验收」的项目计划。
   * @param request `{ goal, projectRoot, sessions?: [{sessionId, project, title}] }`
   */
  async planProject(request, signal) {
    const ctx = this.ctx
    const goal = str(request?.goal).trim()
    const projectRootRaw = str(request?.projectRoot).trim()
    const projectRoot = path.resolve(
      projectRootRaw === ''
        ? path.join(os.homedir(), 'dsh-projects')
        : projectRootRaw === '~'
          ? os.homedir()
          : projectRootRaw.startsWith('~/')
            ? path.join(os.homedir(), projectRootRaw.slice(2))
            : projectRootRaw,
    )
    if (goal === '') throw new Error('目标为空')

    const sessions = Array.isArray(request?.sessions) ? request.sessions : []
    const usable = sessions
      .map(item => ({ sessionId: str(item?.sessionId), project: str(item?.project), title: str(item?.title) }))
      .filter(item => item.sessionId !== '')
      .slice(0, 40)
    const allowedExisting = new Set(usable.map(item => item.sessionId))
    const existingBlock =
      usable.length === 0
        ? '用户没有提供已有对话；所有步骤都用新建对话。'
        : [
            '用户现有的对话（只有在目标里明确点名时才复用；否则一律新建）：',
            ...usable.map(item => `- sessionId=${item.sessionId} ｜ 项目=${item.project || '未知'} ｜ 标题=${item.title || '未命名'}`),
          ].join('\n')

    const instruction = PROJECT_PLAN_INSTRUCTIONS
      .replace('{goal}', goal)
      .replace('{projectRoot}', projectRoot)
      .replace('{existingBlock}', existingBlock)

    let text = ''
    let warning
    try {
      text = await generate(ctx, instruction, signal)
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error)
    }
    let parsed = parseJsonLoose(text)
    if (parsed === undefined && text.trim() !== '') {
      try {
        text = await generate(
          ctx,
          instruction + '\n\n上一次输出无法解析。请只输出一个合法的 JSON 对象，不要任何其他文字。',
          signal,
        )
        parsed = parseJsonLoose(text)
      } catch (_) {
        parsed = undefined
      }
    }
    if (parsed === undefined) {
      return { steps: [], summary: '', warning: warning ?? '模型没有返回可解析的项目计划', raw: cleanAnswer(text).slice(0, 2000) }
    }

    // 允许的目录：工作区根目录之下，或已有对话所在目录（复用现有项目）。
    const existingCwds = new Map()
    const allowedDirs = new Set()
    for (const item of usable) {
      if (item.project === '') continue
      const dir = path.resolve(item.project)
      existingCwds.set(item.sessionId, dir)
      allowedDirs.add(dir)
    }

    const normalized = normalizeProjectPlan(parsed, {
      projectRoot,
      allowedExisting,
      existingCwds,
      allowedDirs,
    })
    if (normalized.error !== undefined) {
      return { steps: [], summary: '', warning: normalized.error, raw: text.slice(0, 2000) }
    }
    if (normalized.steps.length === 0) {
      return { steps: [], summary: '', warning: '模型返回的计划里没有可用步骤', raw: text.slice(0, 2000) }
    }

    return {
      summary: normalized.summary,
      projects: normalized.projects,
      steps: normalized.steps,
      warning,
    }
  },

  /**
   * 同步需要自动审核的会话清单（整份替换）。
   * @param request `{ entries: [{sessionId, goal}] }`
   */
  async setAutoApproval(request) {
    const entries = Array.isArray(request?.entries) ? request.entries : []
    autoApprovalEntries.clear()
    for (const entry of entries) {
      const sessionId = str(entry?.sessionId)
      if (sessionId === '') continue
      autoApprovalEntries.set(sessionId, { goal: str(entry?.goal).slice(0, 800) })
    }
    return { count: autoApprovalEntries.size }
  },

  /**
   * 读取保存的设置。
   * @param request 占位参数（保持统一的 wire 形状，内容不使用）
   */
  async loadSettings(request) {
    const file = settingsFilePath()
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      return { settings: parsed !== null && typeof parsed === 'object' ? parsed : null, path: file }
    } catch (_) {
      return { settings: null, path: file }
    }
  },

  /**
   * 保存设置。
   * @param request `{ settings: object }`
   */
  async saveSettings(request) {
    const settings = request && request.settings !== null && typeof request.settings === 'object' ? request.settings : {}
    const file = settingsFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
    return { ok: true, path: file }
  },

  /** 连通性自检。 */
  async ping() {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return {
      ok: true,
      provider: selection.provider,
      model: selection.model,
      version: '0.3.0',
    }
  },
}

/* -------------------------------------------------------------------------- *
 * 自动审核
 * -------------------------------------------------------------------------- */

/** sessionId -> { goal }。由浏览器端通过 setAutoApproval 同步。 */
const autoApprovalEntries = new Map()

/** 明显不合理的操作：直接拒绝，不交给模型判断。 */
const DENY_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-zA-Z]*f/i,
  /git\s+push\s+(--force|-f)\b/i,
  /drop\s+(database|table|schema)/i,
  /truncate\s+table/i,
  /mkfs\.|diskutil\s+erase|dd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /chmod\s+-R\s+777\s+\//i,
  /(curl|wget)[^|]*\|\s*(sh|bash)\b/i,
  /(sudo\s|\bsu\s+-)/i,
  />\s*\/dev\/(sd|disk)/i,
  /(所有|全部|整个|统统|全都).{0,12}(删除|删掉|清空|格式化|抹掉)/,
  /(删除|删掉|清空|格式化|抹掉).{0,12}(所有|全部|整个|代码|源码|仓库|数据库)/,
  /(代码|源码|仓库|数据库).{0,12}(全部|都)?\s*(删除|删掉|清空|格式化|抹掉)/,
  /\bdelete\s+(all|every)\b/i,
  /\bremove\s+all\s+(files|code|source)\b/i,
]

const APPROVAL_RUBRIC = [
  '你是「自动审核员」，替用户判断一个 AI 编程助手发起的权限请求是否应当被批准。',
  '',
  '判断标准：',
  '1. 先看这项操作是否与该对话正在做的工作直接相关，再看它是否合理。',
  '2. 属于正常开发操作、并且和工作相关 → allow。包括：读取或搜索文件、运行测试与构建、',
  '   安装依赖、在项目目录内写入或修改文件、启动本地服务，以及**为完成这些操作而申请沙箱提权**',
  '   （danger-full-access）。注意：申请提权本身不是拒绝理由，要看提权之后要做的那件事。',
  '3. 在项目目录之外创建少量测试文件、读取用户明确指出的路径，也属于正常工作范围。',
  '4. 明显不合理或危险 → deny。例如：删除大量代码或数据、清空目录、格式化磁盘、强制推送、',
  '   重置仓库、修改系统配置、访问与工作无关的隐私文件、把源码上传到外部、执行来路不明的脚本。',
  '5. 拿不准时输出 unsure，交给人工处理。',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码围栏：',
  '{"decision":"allow"|"deny"|"unsure","reason":"一句话说明"}',
].join('\n')

/**
 * 判断一条权限请求。返回 { decision, reason }。
 * 规则优先，不确定再问模型；模型不可用就返回 unsure（交给人）。
 */
async function decideApproval(ctx, input, signal) {
  const haystack = `${input.toolName}\n${input.reason}`
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(haystack)) {
      return { decision: 'deny', reason: '匹配到高风险操作：' + pattern.source.slice(0, 40) }
    }
  }
  const instruction = [
    APPROVAL_RUBRIC,
    '',
    '该对话正在做的工作：',
    '"""',
    input.goal || '（未提供）',
    '"""',
    '',
    `请求的工具：${input.toolName || '未知'}`,
    '请求原因 / 说明：',
    '"""',
    input.reason || '（没有提供说明）',
    '"""',
    '',
    '请给出决定。',
  ].join('\n')
  try {
    const text = await generate(ctx, instruction, signal)
    const parsed = parseJsonLoose(text)
    const decision = str(parsed?.decision).trim()
    if (decision === 'allow' || decision === 'deny' || decision === 'unsure') {
      return { decision, reason: str(parsed?.reason).trim() }
    }
    return { decision: 'unsure', reason: '模型返回无法解析' }
  } catch (error) {
    return { decision: 'unsure', reason: '审核模型不可用：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** Host 侧前置审批监听：命中托管会话就代为决定，否则交给人。 */
async function handleApprovalRequest(ctx, request, next) {
  try {
    const agent = request?.agent
    const sessionId = agent && agent.session ? agent.session.id : ''
    const entry = sessionId === '' ? undefined : autoApprovalEntries.get(sessionId)
    if (entry === undefined) return next()
    const outcome = await decideApproval(ctx, {
      toolName: str(request?.toolName),
      reason: str(request?.reason) || str(request?.displayReason),
      goal: entry.goal,
    }, request?.signal)
    try {
      console.log('[work-assistant] 自动审核 →', outcome.decision, '|', str(request?.toolName), '|', outcome.reason)
    } catch (_) {
      /* 日志失败不影响裁决 */
    }
    if (outcome.decision === 'allow') return 'allowed-once'
    if (outcome.decision === 'deny') return 'rejected'
    return next()
  } catch (_) {
    return next()
  }
}

markRemoteMethods(servicePrototype, ['refine', 'ping', 'planFlow', 'composeStep', 'planProject', 'prepareProject', 'setAutoApproval', 'loadSettings', 'saveSettings'])

module.exports = {
  name: 'work-assistant',
  inject: ['llm', 'agentDefaultModel'],
  apply(ctx) {
    // 前置注册，确保在转发给浏览器之前拿到审批请求。
    ctx.on('approval/request', (request, next) => handleApprovalRequest(ctx, request, next), { prepend: true })

    const service = Object.create(servicePrototype)
    service.ctx = ctx
    service.typertRemote = Object.freeze({
      service,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
    ctx.provide(SERVICE_KEY, service)
  },
}
module.exports.default = module.exports
