/**
 * 应用根组件：组装机制说明、注入说明、参数面板、成本对比表与模型假设；
 * 参数状态集中在此，表格行随参数由 buildTable 重算。
 */
import { useMemo, useState } from 'react';
import { AssumptionsSection } from './components/AssumptionsSection';
import { CostTable } from './components/CostTable';
import { InjectionSection } from './components/InjectionSection';
import { MechanismSection } from './components/MechanismSection';
import { ParamsPanel } from './components/ParamsPanel';
import { buildTable, DEFAULT_PARAMS, type ModelParams } from './model';

/** 应用根组件。 */
export default function App() {
  const [params, setParams] = useState<ModelParams>({ ...DEFAULT_PARAMS });
  const [resetKey, setResetKey] = useState(0);
  const rows = useMemo(() => buildTable(params), [params]);
  return (
    <div className="page">
      <header className="hero">
        <h1>dsh-plugin-om</h1>
        <p>
          Observational Memory 风格的上下文管理插件：自动压缩历史消息为摘要、支持回看原始内容。
          本页说明其机制、dsh 注入消息的处理方式，并用可调参数估算启用 om 的 token 消耗与费用。
        </p>
        <p className="links">
          <a href="https://github.com/FanetheDivine/dsh-plugin-om">GitHub 仓库</a>
          <a href="https://www.npmjs.com/package/dsh-plugin-om">npm 包</a>
          <a href="https://mastra.ai/research/observational-memory">Observational Memory</a>
        </p>
      </header>
      <MechanismSection />
      <InjectionSection />
      <ParamsPanel
        key={resetKey}
        params={params}
        onChange={setParams}
        onReset={() => {
          setParams({ ...DEFAULT_PARAMS });
          setResetKey((k) => k + 1);
        }}
      />
      <CostTable rows={rows} />
      <AssumptionsSection />
      <footer>
        本站是 dsh-plugin-om 的说明与成本计算器，不随插件 npm
        包发布；模型为估算，实际消耗以账单为准。
      </footer>
    </div>
  );
}
