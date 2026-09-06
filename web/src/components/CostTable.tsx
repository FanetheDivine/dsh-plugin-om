/**
 * 成本对比表：原始会话规模 20k–250k 逐行对比 om 开/关的三类 token 消耗、费用、
 * 压缩次数与节省额。数据由 web/src/model.ts 的 buildTable 生成。
 * 下方列出表格成立的假设：step token 均匀增长、step 输出不计入公式、thinking 始终不压缩、
 * 压缩会话经验公式计费与前缀缓存口径；「原始规模」说明置于表头 tooltip。
 * 每格合并显示两个值：om 开启（绿）/ om 关闭（红），保留当前配色。
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSignedUsd, formatTokens, formatUsd } from '../format';
import type { CostRow } from '../model';

/** 成本对比表属性。 */
type CostTableProps = {
  /** 表格全部行（由 App 按 params 计算后传入）。 */
  rows: CostRow[];
};

/** 合并单元格：om 开启（绿）/ om 关闭（红）双值展示，居中。 */
function MergedCell({ off, on }: { off: string; on: string }) {
  return (
    <TableCell className="text-center tabular-nums">
      <span className="text-om-on">{on}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-om-off">{off}</span>
    </TableCell>
  );
}

/** 成本对比表组件：合并单元格 + 节省额高亮，居中列对齐。 */
export function CostTable({ rows }: CostTableProps) {
  return (
    <section id="table" className="flex flex-col items-center">
      <div className="mb-4 w-full max-w-4xl text-center">
        <h2 className="text-xl font-semibold tracking-tight">成本对比</h2>
      </div>
      <div className="w-full max-w-4xl overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-center">
                <span className="inline-flex items-center gap-1">
                  原始规模
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help text-[10px] text-muted-foreground/70">ⓘ</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-48">
                      不开启 OM 时对话占据的上下文，由系统提示词、dsh 注入消息与各 step 输入构成
                    </TooltipContent>
                  </Tooltip>
                </span>
              </TableHead>
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
      <div className="mt-4 w-full max-w-4xl">
        <p className="text-sm text-muted-foreground">
          表格内展示 OM 开/关情况的会话数据，基于理想情况下的长对话进行计算，并做如下假设：
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            每个 step 的 token 均匀增长：每 step 模型接受 800 token
            数据（text、tool-args、用户&系统消息、tool-result）
          </li>
          <li>每 step 的 320 token 输出（thinking、text、tool-args）不计入公式</li>
          <li>thinking 始终不压缩</li>
          <li>
            每次压缩（观察/反思）按公式计费：缓存创建 ≈ 1.3 × 输入，缓存读 ≈ 1.75 × 输入，输出 ≈
            压缩比 × 输入 + 5,000
          </li>
          <li>
            前缀缓存：首轮整段缓存创建，之后每轮缓存读取上一轮、缓存写入本轮新增；压缩替换后重建
          </li>
        </ul>
      </div>
    </section>
  );
}
