/**
 * dsh 注入消息说明区：AGENTS.md / skill 定义 / runtime context 的注入形态，
 * 以及 om 压缩后它们变为 <sys> 空条目的收益说明。
 */

/** dsh 注入消息说明区组件。 */
export function InjectionSection() {
  return (
    <section className="card" id="injection">
      <h2>dsh 注入的系统消息</h2>
      <p>
        dsh 会在会话中注入一批「系统消息」：<strong>AGENTS.md</strong>（工作区开发约定）、
        <strong>skill 定义</strong>（可用技能目录）、runtime context
        等。它们以用户消息事件的形式写入会话，但 source.kind 不是
        <code>user</code>
        ；在完整消息索引中被归为「系统消息」一类，同样占上下文、每轮随前缀重复发送。 本页参数「dsh
        注入消息」默认按 5,000 tokens 估算。
      </p>

      <h3>om 压缩时系统消息的待遇</h3>
      <p>
        观察压缩把消息渲染为 &lt;history&gt; 块时，系统消息渲染为<strong>空条目</strong>：
      </p>
      <pre className="snippet">{`<history>
<user_message index="3">…用户消息原文（逐条保留）…</user_message>
<sys type="system-reminder" index="4"></sys>
<assistant start="5" end="9">…关联消息聚合的模块摘要…</assistant>
</history>`}</pre>
      <ul>
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
      <p>
        这意味着首次观察压缩后，AGENTS.md 与 skill 定义等内容不再占用上下文，是 om
        相对「原文保留」策略的一项隐性收益；下方成本表中 om
        开启场景的峰值上下文会明显低于原始会话规模。
      </p>
    </section>
  );
}
