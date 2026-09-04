/**
 * OM 机制简述区：观察、反思与 dsh 注入，含百万上下文窗口建议。
 * 保持简洁，不做细节展开。
 */
export function MechanismOverview() {
  return (
    <section className="rounded-xl border bg-card text-card-foreground shadow-sm" id="mechanism">
      <div className="p-6 pb-4">
        <h2 className="text-xl font-semibold tracking-tight">机制</h2>
        <p className="mt-1 text-sm text-muted-foreground">观察、反思与 dsh 注入的简要说明。</p>
      </div>
      <div className="px-6 pb-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">观察</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              净压力 ≥ 观察阈值（默认 45k）时，把未压缩消息摘要为 &lt;history&gt; 块，
              替换原始消息；尾部保留最近 5 条不压缩。
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">反思</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              &lt;history&gt; 块合计 ≥ 反思阈值（默认 120k）时，把多个摘要合并为一条更紧凑的摘要，
              防止摘要自身膨胀。
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold">dsh 注入</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              AGENTS.md、skill 定义等以系统消息注入会话；观察压缩时渲染为 &lt;sys&gt; 空条目，
              不进摘要、不占上下文。
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-primary/20 bg-accent p-4">
          <p className="text-sm font-medium text-accent-foreground">
            百万上下文建议：保持窗口占用 &lt; 250k，避免智力降低。
          </p>
        </div>
      </div>
    </section>
  );
}
