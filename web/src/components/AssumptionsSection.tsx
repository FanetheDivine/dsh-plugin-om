/**
 * 模型假设区：成本模型的口径、计费规则与忽略项（与 web/src/model.ts 文件头一致）。
 */

/** 模型假设区组件。 */
export function AssumptionsSection() {
  return (
    <section className="card" id="assumptions">
      <h2>模型假设</h2>
      <ul>
        <li>
          会话从固定前缀开始：系统提示词 + dsh 注入消息，每轮请求重复发送；按
          <strong>前缀缓存</strong>计费 —— 首轮缓存创建完整前缀，此后每轮缓存读取上一轮
          prompt、缓存创建本轮新增量。
        </li>
        <li>每轮新增 Δ tokens：用户消息与模型回复各 Δ/2，回复按补全价格计费。</li>
        <li>
          om 开启：pre-step 先反思后观察；净压力 ≈ 未压缩对话量 + 未遮蔽注入量，≥
          观察阈值触发观察压缩；首次观察把注入消息遮蔽为 &lt;sys&gt; 空条目（残留按 50 tokens
          计）；history 块合计 ≥ 反思阈值触发合并。
        </li>
        <li>
          摘要调用按<strong>无缓存新会话</strong>计费：input = 指令（约 1,000 tokens）+
          被压缩内容，output = 压缩比 × 输入内容。
        </li>
        <li>
          压缩替换破坏前缀缓存：该轮主请求只缓存读取替换点之前的前缀（系统提示词 +
          旧摘要块），其余重新缓存创建。
        </li>
        <li>
          忽略项：工具定义 tokens（实际会推迟观察触发）、XML 渲染开销、尾部保留的 5 条消息、429
          限流重试。
        </li>
        <li>
          默认参数下 250k 以内<strong>反思不会触发</strong>：每次观察约增加 1,350 tokens
          摘要块，达到 120k 反思阈值约需 89 次观察（对应数百万 tokens
          的会话）；调小反思阈值或调大压缩比后表格会正确反映反思行为。
        </li>
      </ul>
    </section>
  );
}
