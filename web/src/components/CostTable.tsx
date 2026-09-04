/**
 * 成本对比表：原始会话规模 20k–250k 逐行对比 om 开/关的四类 token 消耗、费用、
 * 峰值上下文与压缩次数、节省额。数据由 web/src/model.ts 的 buildTable 生成。
 */
import { formatSignedUsd, formatTokens, formatUsd } from '../format';
import type { CostRow } from '../model';

/** 成本对比表属性。 */
type CostTableProps = {
  /** 表格全部行（由 App 按 params 计算后传入）。 */
  rows: CostRow[];
};

/** 单个场景的 token/费用单元格组（输入/补全/缓存读/缓存写/费用/峰值）。 */
function ScenarioCells({ row, enabled }: { row: CostRow; enabled: boolean }) {
  const s = enabled ? row.on : row.off;
  return (
    <>
      <td className="num">{formatTokens(s.input)}</td>
      <td className="num">{formatTokens(s.completion)}</td>
      <td className="num">{formatTokens(s.cacheRead)}</td>
      <td className="num">{formatTokens(s.cacheWrite)}</td>
      <td className="num strong">{formatUsd(s.cost)}</td>
      <td className="num">{formatTokens(s.peakPromptTokens)}</td>
    </>
  );
}

/** 成本对比表组件：两级表头（场景分组 + 指标列）。 */
export function CostTable({ rows }: CostTableProps) {
  return (
    <section className="card" id="table">
      <h2>成本对比表</h2>
      <p>
        「原始会话规模」= 系统提示词 + dsh 注入消息 + 对话内容增长到的总量；每行模拟一个完整会话的
        <strong>全部轮次累计</strong>计费（前缀缓存口径）。om 开启场景中「输入」列为摘要调用
        input（主请求全部命中前缀缓存），「观察/反思」列为触发次数。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>原始会话规模</th>
              <th colSpan={6} className="group off">
                om 关闭
              </th>
              <th colSpan={7} className="group on">
                om 开启
              </th>
              <th rowSpan={2}>费用节省</th>
            </tr>
            <tr>
              <th>输入</th>
              <th>补全</th>
              <th>缓存读取</th>
              <th>缓存创建</th>
              <th>费用</th>
              <th>峰值上下文</th>
              <th>输入</th>
              <th>补全</th>
              <th>缓存读取</th>
              <th>缓存创建</th>
              <th>费用</th>
              <th>峰值上下文</th>
              <th>观察/反思</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.targetTokens}>
                <th scope="row" className="num">
                  {formatTokens(row.targetTokens)}
                </th>
                <ScenarioCells row={row} enabled={false} />
                <ScenarioCells row={row} enabled />
                <td className="num strong">{`${row.on.observeCount} / ${row.on.reflectCount}`}</td>
                <td className={`num strong savings ${row.savings >= 0 ? 'pos' : 'neg'}`}>
                  {formatSignedUsd(row.savings)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        短会话下 om
        可能「不回本」：观察压缩的摘要费用发生在压缩当下，而缓存读取的节省要靠后续轮次积累；
        会话越长收益越大，且 om 开启场景的峰值上下文稳定在观察阈值附近（约 系统提示词 +
        观察阈值），不会随规模增长。
      </p>
    </section>
  );
}
