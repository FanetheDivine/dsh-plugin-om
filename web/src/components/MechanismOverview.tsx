/**
 * OM 机制简述区：观察阈值计算、如何观察、反思、以及 dsh 注入机制。
 * 合并自原 MechanismSection + InjectionSection，内容保持静态现状描述。
 */
export function MechanismOverview() {
  return (
    <section className="rounded-lg border bg-card text-card-foreground shadow-sm" id="mechanism">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="text-2xl font-semibold leading-none tracking-tight">om 的机制</h3>
        <p className="text-sm text-muted-foreground">
          观察阈值计算、如何观察、反思、以及 dsh 注入的处理方式。
        </p>
      </div>
      <div className="p-6 pt-0 space-y-4">
        <p>
          长会话中上下文持续增长：每一轮请求都要重复发送全部历史消息，token
          费用与响应延迟随轮数线性上升。om（Observational Memory 风格的上下文管理策略）在{' '}
          <strong>agent/pre-step</strong>（每次模型请求前）自动把历史消息压缩为 &lt;history&gt;
          摘要块，用摘要替换原始消息，让上下文长期稳定在小规模。
        </p>

        <div>
          <h4 className="text-sm font-semibold mb-2">两级压缩</h4>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              <strong>观察（observe）</strong>：净压力 ≥ 观察阈值（默认 45,000
              tokens）时，把未压缩消息摘要为一个新的 &lt;history&gt; 块，<strong>精确替换</strong>
              被压缩的消息区间（旧块保留，追加在后）；尾部保留最近 5
              条消息不压缩，保证近期上下文完整。
            </li>
            <li>
              <strong>反思（reflect）</strong>：全部 &lt;history&gt; 块 token 合计 ≥ 反思阈值（默认
              120,000 tokens）时，把多个摘要块合并为一条更紧凑的摘要，防止摘要自身无限膨胀。
            </li>
            <li>
              两级在 pre-step <strong>阻塞串行</strong>
              执行（先反思后观察），仅主会话生效；摘要尝试全部耗尽时拒绝当前 step、中断当前
              turn（signal 中止除外）。
            </li>
          </ul>
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-2">触发判定：净压力</h4>
          <pre className="formula">
            净压力 = 上下文压力 − 已压缩 &lt;history&gt; 块 token 合计 − 系统提示词估算 −
            工具定义估算
          </pre>
          <p className="text-sm text-muted-foreground mt-1">
            扣除项意味着：已经压缩过的部分不会重复计入压力，系统提示词与工具定义这类「每轮都固定存在」的前缀也不推动触发
            —— 真正驱动压缩的是<strong>未压缩的对话量</strong>。
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-2">摘要调用是一次独立的新会话</h4>
          <p className="text-sm">
            摘要直连 LLM：共享压缩指令作为 system，被压缩消息渲染为合法 &lt;history&gt; 块作为唯一的
            user 输入，不沿用主会话请求前缀。输出经过严格校验（XML 结构合法、不含思考过程、条目
            index 连续覆盖被压缩区间），校验失败自动重试（默认最多 5 次），全部耗尽则中断当前 turn
            而不是产出坏摘要。
          </p>
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-2">压缩后仍可回看原始内容</h4>
          <p className="text-sm">
            事件日志仅追加：被压缩（遮蔽）的消息仍然完整保留在会话日志里。模型随时可以用工具回看：
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              <code>recall</code>：按完整消息 index 区间精确回看原始内容（图片附件随结果保留）；
            </li>
            <li>
              <code>recall-semantic</code>：本地嵌入模型按语义检索全部完整消息（只匹配文本）。
            </li>
          </ul>
          <p className="text-sm">
            浏览器端会渲染折叠式「已压缩」卡片、压缩中提示行与失败错误行，压缩过程对用户可见。
          </p>
        </div>

        <div className="border-t pt-4">
          <h4 className="text-sm font-semibold mb-2">dsh 注入的系统消息</h4>
          <p className="text-sm">
            dsh 会在会话中注入一批「系统消息」：<strong>AGENTS.md</strong>（工作区开发约定）、
            <strong>skill 定义</strong>（可用技能目录）、runtime context
            等。它们以用户消息事件的形式写入会话，但 source.kind 不是
            <code>user</code>
            ；在完整消息索引中被归为「系统消息」一类，同样占上下文、每轮随前缀重复发送。本页参数「dsh
            注入消息」默认按 5,000 tokens 估算。
          </p>

          <h5 className="text-xs font-semibold mt-2 mb-1">om 压缩时系统消息的待遇</h5>
          <p className="text-sm">
            观察压缩把消息渲染为 &lt;history&gt; 块时，系统消息渲染为<strong>空条目</strong>：
          </p>
          <pre className="snippet">{`<history>
<user_message index="3">…用户消息原文（逐条保留）…</user_message>
<sys type="system-reminder" index="4"></sys>
<assistant start="5" end="9">…关联消息聚合的模块摘要…</assistant>
</history>`}</pre>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              <strong>内容不进摘要输入</strong>：&lt;sys&gt;
              条目在压缩输入里是空块，摘要调用不需要为注入内容付 input 费用；
            </li>
            <li>
              <strong>压缩后基本从上下文消失</strong>：替换后的 &lt;history&gt; 块里只剩
              <code>&lt;sys type="(kind)" index="N"&gt;&lt;/sys&gt;</code>
              空条目（几十 tokens 的残留），模型仍能感知「这里曾有一条某类系统消息」及其位置；
            </li>
            <li>
              用户消息则<strong>逐条保留原文</strong>，不概括、不省略 ——
              压缩优先牺牲的是模型输出与工具结果，不是用户意图。
            </li>
          </ul>
          <p className="text-sm">
            这意味着首次观察压缩后，AGENTS.md 与 skill 定义等内容不再占用上下文，是 om
            相对「原文保留」策略的一项隐性收益；下方成本表中 om
            开启场景的峰值上下文会明显低于原始会话规模。
          </p>
        </div>
      </div>
    </section>
  );
}
