/**
 * OM 机制简述区：观察、反思、dsh 注入、recall，含百万上下文窗口建议。
 * 简洁卡片式，无多余边框。
 */
export function MechanismOverview() {
  const items = [
    {
      title: '观察',
      desc: '净压力 ≥ 观察阈值时，将未压缩消息进行摘要',
    },
    {
      title: '反思',
      desc: '消息摘要 ≥ 反思阈值时，再次摘要',
    },
    {
      title: 'dsh 注入',
      desc: 'AGENTS.md、skill 定义等系统消息总是在压缩后会被再次注入',
    },
    {
      title: 'recall',
      desc: '模型可以回看原始消息',
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
