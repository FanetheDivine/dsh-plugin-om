/**
 * 机制说明区：om 的两级压缩（观察/反思）、触发判定公式、摘要调用形态与回看能力。
 * 内容与插件 README / src/compress.ts 的现状描述保持一致。
 */

/** 机制说明区组件。 */
export function MechanismSection() {
  return (
    <section className="card" id="mechanism">
      <h2>om 的机制</h2>
      <p>
        长会话中上下文持续增长：每一轮请求都要重复发送全部历史消息，token
        费用与响应延迟随轮数线性上升。om（Observational Memory 风格的上下文管理策略）在{' '}
        <strong>agent/pre-step</strong>（每次模型请求前）自动把历史消息压缩为 &lt;history&gt;
        摘要块，用摘要替换原始消息，让上下文长期稳定在小规模。
      </p>

      <h3>两级压缩</h3>
      <ul>
        <li>
          <strong>观察（observe）</strong>：净压力 ≥ 观察阈值（默认 45,000
          tokens）时，把未压缩消息摘要为一个新的 &lt;history&gt; 块，<strong>精确替换</strong>
          被压缩的消息区间（旧块保留，追加在后）；尾部保留最近 5 条消息不压缩，保证近期上下文完整。
        </li>
        <li>
          <strong>反思（reflect）</strong>：全部 &lt;history&gt; 块 token 合计 ≥ 反思阈值（默认
          120,000 tokens）时，把多个摘要块合并为一条更紧凑的摘要，防止摘要自身无限膨胀。
        </li>
        <li>
          两级在 pre-step <strong>阻塞串行</strong>
          执行（先反思后观察），仅主会话生效；摘要尝试全部耗尽时拒绝当前 step、中断当前 turn（signal
          中止除外）。
        </li>
      </ul>

      <h3>触发判定：净压力</h3>
      <pre className="formula">
        净压力 = 上下文压力 − 已压缩 &lt;history&gt; 块 token 合计 − 系统提示词估算 − 工具定义估算
      </pre>
      <p>
        扣除项意味着：已经压缩过的部分不会重复计入压力，系统提示词与工具定义这类「每轮都固定存在」的前缀也不推动触发
        —— 真正驱动压缩的是<strong>未压缩的对话量</strong>。
      </p>

      <h3>摘要调用是一次独立的新会话</h3>
      <p>
        摘要直连 LLM：共享压缩指令作为 system，被压缩消息渲染为合法 &lt;history&gt; 块作为唯一的
        user 输入，不沿用主会话请求前缀。输出经过严格校验（XML 结构合法、不含思考过程、条目 index
        连续覆盖被压缩区间），校验失败自动重试（默认最多 5 次），全部耗尽则中断当前 turn
        而不是产出坏摘要。
      </p>

      <h3>压缩后仍可回看原始内容</h3>
      <p>事件日志仅追加：被压缩（遮蔽）的消息仍然完整保留在会话日志里。模型随时可以用工具回看：</p>
      <ul>
        <li>
          <code>recall</code>：按完整消息 index 区间精确回看原始内容（图片附件随结果保留）；
        </li>
        <li>
          <code>recall-semantic</code>：本地嵌入模型按语义检索全部完整消息（只匹配文本）。
        </li>
      </ul>
      <p>浏览器端会渲染折叠式「已压缩」卡片、压缩中提示行与失败错误行，压缩过程对用户可见。</p>
    </section>
  );
}
