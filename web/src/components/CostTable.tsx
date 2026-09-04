/**
 * 成本对比表：原始会话规模 20k–250k 逐行对比 om 开/关的四类 token 消耗、费用、
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

/** 合并单元格：om 关闭（红）/ om 开启（绿）双值展示。 */
function MergedCell({ off, on }: { off: string; on: string }) {
  return (
    <TableCell className="text-right tabular-nums">
      <span className="text-om-off">{off}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-om-on">{on}</span>
    </TableCell>
  );
}

/** 成本对比表组件：合并单元格 + 节省额高亮。 */
export function CostTable({ rows }: CostTableProps) {
  return (
    <section className="rounded-xl border bg-card text-card-foreground shadow-sm" id="table">
      <div className="p-6 pb-4">
        <h2 className="text-xl font-semibold tracking-tight">成本对比</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          「原始会话规模」= 系统提示词 + dsh 注入消息 + 对话内容总量；每行模拟一个完整会话的
          <strong>全部轮次累计</strong>计费（前缀缓存口径）。每格显示 om 关闭（红）/ om 开启（绿）。
        </p>
      </div>
      <div className="overflow-x-auto px-6 pb-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">原始规模</TableHead>
              <TableHead className="text-right">输入</TableHead>
              <TableHead className="text-right">补全</TableHead>
              <TableHead className="text-right">缓存读取</TableHead>
              <TableHead className="text-right">缓存创建</TableHead>
              <TableHead className="text-right">费用</TableHead>
              <TableHead className="text-right">观察 / 反思</TableHead>
              <TableHead className="text-right">节省</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.targetTokens}>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatTokens(row.targetTokens)}
                </TableCell>
                <MergedCell off={formatTokens(row.off.input)} on={formatTokens(row.on.input)} />
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
                <TableCell className="text-right tabular-nums">
                  <span className="text-om-on">{row.on.observeCount}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-om-on">{row.on.reflectCount}</span>
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums font-semibold ${row.savings >= 0 ? 'text-om-on' : 'text-om-off'}`}
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
