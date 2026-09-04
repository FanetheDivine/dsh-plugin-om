/**
 * 应用根组件：左侧参数侧边栏 + 右侧机制说明与成本对比表；
 * 参数状态集中在此，表格行随参数由 buildTable 重算。
 */
import { useMemo, useState } from 'react';
import { CostTable } from './components/CostTable';
import { MechanismOverview } from './components/MechanismOverview';
import { ParamsPanel } from './components/ParamsPanel';
import { buildTable, DEFAULT_PARAMS, type ModelParams } from './model';

/** 应用根组件。 */
export default function App() {
  const [params, setParams] = useState<ModelParams>({ ...DEFAULT_PARAMS });
  const [resetKey, setResetKey] = useState(0);
  const rows = useMemo(() => buildTable(params), [params]);
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* 侧边栏：参数调节 */}
      <aside className="w-full shrink-0 border-b bg-background lg:w-80 lg:border-b-0 lg:border-r">
        <ParamsPanel
          key={resetKey}
          params={params}
          onChange={setParams}
          onReset={() => {
            setParams({ ...DEFAULT_PARAMS });
            setResetKey((k) => k + 1);
          }}
        />
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 space-y-6 overflow-x-auto px-4 py-6 sm:px-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">dsh-plugin-om</h1>
          <p className="text-sm text-muted-foreground">
            Observational Memory 风格的上下文管理插件：自动压缩历史消息为摘要、支持回看原始内容。
            本页说明其机制，并用可调参数估算启用 om 的 token 消耗与费用。
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            <a href="https://github.com/FanetheDivine/dsh-plugin-om">GitHub 仓库</a>
            <a href="https://www.npmjs.com/package/dsh-plugin-om">npm 包</a>
            <a href="https://mastra.ai/research/observational-memory">Observational Memory</a>
          </div>
        </header>
        <MechanismOverview />
        <CostTable rows={rows} />
        <footer className="pb-4 text-center text-xs text-muted-foreground">
          本站是 dsh-plugin-om 的说明与成本计算器，不随插件 npm
          包发布；模型为估算，实际消耗以账单为准。
        </footer>
      </main>
    </div>
  );
}
