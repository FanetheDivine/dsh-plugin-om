/**
 * 应用根组件：顶部机制说明 + 右侧参数侧边栏 + 居中成本对比表；
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
    <div className="flex min-h-screen flex-col">
      {/* 顶部通栏：标题 + 机制说明 */}
      <div className="bg-background">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">dsh-plugin-om</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Observational Memory 风格的上下文管理插件
              </p>
            </div>
            <div className="flex gap-4 text-sm">
              <a href="https://github.com/FanetheDivine/dsh-plugin-om">GitHub</a>
              <a href="https://www.npmjs.com/package/dsh-plugin-om">npm</a>
              <a href="https://mastra.ai/research/observational-memory">Observational Memory</a>
            </div>
          </header>
          <MechanismOverview />
        </div>
      </div>

      {/* 主体：左侧表格 + 右侧参数侧边栏 */}
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-6 py-6">
        <main className="min-w-0 flex-1 overflow-x-auto">
          <CostTable rows={rows} />
        </main>
        <aside className="w-72 shrink-0">
          <div className="sticky top-6">
            <ParamsPanel
              key={resetKey}
              params={params}
              onChange={setParams}
              onReset={() => {
                setParams({ ...DEFAULT_PARAMS });
                setResetKey((k) => k + 1);
              }}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
