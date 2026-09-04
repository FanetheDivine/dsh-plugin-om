/**
 * 成本对比表：原始会话规模 20k–250k 逐行对比 om 开/关的三类 token 消耗、费用、
 * 压缩次数与节省额。数据由 web/src/model.ts 的 buildTable 生成。
 * 每格合并显示两个值：om 关闭（红）/ om 开启（绿），保留当前配色。
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatSignedUsd, formatTokens, formatUsd } from '../format';
import type { CostRow } from '../model';

/** 成本对比表属性。 */
type CostTableProps = {
  /** 表格全部行（由 App 按 params 计算后传入）。 */
  rows: CostRow[];
};

/** 合并单元格：om 关闭（红）/ om 开启（绿）双值展示，居中。 */
function MergedCell({ off, on }: { off: string; on: string }) {
  return (
    <TableCell className="text-center tabular-nums">
      <span className="text-om-off">{off}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-om-on">{on}</span>
    </TableCell>
  );
}

/** 成本对比表组件：合并单元格 + 节省额高亮，居中列对齐。 */
export function CostTable({ rows }: CostTableProps) {
  return (
    <section id="table" className="flex flex-col items-center">
      <div className="mb-4 w-full max-w-4xl text-center">
        <h2 className="text-xl font-semibold tracking-tight">成本对比</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          此表格展示不同上下文窗口占用情况下，是否启用OM的token和计费情况
          <br />
          表格显示 om 关闭/开启 的值
          <br />
          dsh 全程为请求打缓存标记：主会话 prompt 命中前缀缓存（读）或写入缓存（创建），
          不产生未受缓存保护的输入；om 的摘要调用为独立新会话，其请求量计入缓存创建列
        </p>
      </div>
      <div className="w-full max-w-4xl overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-center">原始规模</TableHead>
              <TableHead className="text-center">输出</TableHead>
              <TableHead className="text-center">缓存读取</TableHead>
              <TableHead className="text-center">缓存创建</TableHead>
              <TableHead className="text-center">费用</TableHead>
              <TableHead className="text-center">观察 / 反思</TableHead>
              <TableHead className="text-center">节省</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.targetTokens}>
                <TableCell className="text-center font-medium tabular-nums">
                  {formatTokens(row.targetTokens)}
                </TableCell>
                <MergedCell
                  off={formatTokens(row.off.completion)}
                  on={formatTokens(row.on.completion)}
                />
                <MergedCell
                  off={formatTokens(row.off.cacheRead)}
                  on={formatTokens(row.on.cacheRead)}
                />
                <MergedCell
                  off={formatTokens(row.off.cacheWrite)}
                  on={formatTokens(row.on.cacheWrite)}
                />
                <MergedCell off={formatUsd(row.off.cost)} on={formatUsd(row.on.cost)} />
                <TableCell className="text-center tabular-nums">
                  <span className="text-om-on">{row.on.observeCount}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-om-on">{row.on.reflectCount}</span>
                </TableCell>
                <TableCell
                  className={`text-center tabular-nums font-semibold ${row.savings >= 0 ? 'text-om-on' : 'text-om-off'}`}
                >
                  {formatSignedUsd(row.savings)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
