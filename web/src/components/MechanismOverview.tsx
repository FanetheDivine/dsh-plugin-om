/**
 * OM 机制简述区：观察、反思、dsh 注入、recall，含百万上下文窗口建议。
 * 简洁卡片式，无多余边框。
 */
export function MechanismOverview() {
  const items = [
    {
      title: '观察',
      desc: '净压力 ≥ 观察阈值（默认 45k）时，把未压缩消息摘要为 history 块，替换原始消息；尾部保留最近 5 条不压缩。',
    },
    {
      title: '反思',
      desc: 'history 块合计 ≥ 反思阈值（默认 120k）时，合并为一条更紧凑的摘要，防止摘要膨胀。',
    },
    {
      title: 'dsh 注入',
      desc: 'AGENTS.md、skill 定义等系统消息在观察压缩时渲染为空条目，不进摘要、不占上下文。',
    },
    {
      title: 'recall',
      desc: '被压缩的消息仍完整保留在会话日志中，可通过 recall 工具按 index 区间或语义回看原始内容。',
    },
  ];
  return (
    <section id="mechanism">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <div key={item.title} className="rounded-lg bg-muted/50 p-4">
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.desc}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg bg-accent px-4 py-3">
        <p className="text-sm font-medium text-accent-foreground">
          百万上下文建议：保持窗口占用 {'<'} 250k，避免智力降低。
        </p>
      </div>
    </section>
  );
}
