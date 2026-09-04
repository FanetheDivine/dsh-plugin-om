/**
 * 参数面板：会话假设 / om 参数 / Token 价格三组可调输入，实时驱动成本对比表。
 * 导出 ParamsPanel；输入为非受控 NumberField（失焦归一化），重置按钮经 key 重挂载。
 */
import { useState } from 'react';
import { type ModelParams, OPUS_PRICES } from '../model';

/** 数值输入字段属性。 */
type NumberFieldProps = {
  /** 字段标签。 */
  label: string;
  /** 初始值（非受控）。 */
  defaultValue: number;
  /** 最小值（低于该值的输入不提交）。 */
  min: number;
  /** 步进。 */
  step: number;
  /** 单位后缀（展示用）。 */
  unit?: string;
  /** 提交合法值时的回调。 */
  onCommit: (value: number) => void;
};

/** 非受控数值输入：输入过程中解析合法值即提交；失焦时把文本归一化为已提交值。 */
function NumberField({ label, defaultValue, min, step, unit, onCommit }: NumberFieldProps) {
  const [text, setText] = useState(String(defaultValue));
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && n >= min) onCommit(n);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          value={text}
          min={min}
          step={step}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => {
            const n = Number(text);
            setText(String(Number.isFinite(n) && n >= min ? n : defaultValue));
          }}
        />
        {unit !== undefined ? <em>{unit}</em> : null}
      </span>
    </label>
  );
}

/** 参数面板属性。 */
type ParamsPanelProps = {
  /** 当前参数（用于重置按钮）。 */
  params: ModelParams;
  /** 参数变更回调。 */
  onChange: (next: ModelParams) => void;
  /** 恢复默认并重挂载面板的回调。 */
  onReset: () => void;
};

/** 参数面板组件：三组字段 + 恢复默认按钮。 */
export function ParamsPanel({ params, onChange, onReset }: ParamsPanelProps) {
  const set = (patch: Partial<ModelParams>) => onChange({ ...params, ...patch });
  const setPrice = (key: keyof ModelParams['prices'], value: number) =>
    onChange({ ...params, prices: { ...params.prices, [key]: value } });
  return (
    <section className="card" id="params">
      <h2>
        可调参数
        <button type="button" className="reset" onClick={onReset}>
          恢复默认
        </button>
      </h2>
      <div className="param-groups">
        <fieldset>
          <legend>会话假设</legend>
          <NumberField
            label="系统提示词"
            unit="tokens"
            defaultValue={params.systemPromptTokens}
            min={0}
            step={500}
            onCommit={(v) => set({ systemPromptTokens: v })}
          />
          <NumberField
            label="dsh 注入消息"
            unit="tokens"
            defaultValue={params.injectedTokens}
            min={0}
            step={500}
            onCommit={(v) => set({ injectedTokens: v })}
          />
          <NumberField
            label="每轮新增"
            unit="tokens"
            defaultValue={params.turnDeltaTokens}
            min={100}
            step={100}
            onCommit={(v) => set({ turnDeltaTokens: v })}
          />
          <NumberField
            label="压缩比"
            unit="%"
            defaultValue={params.compressionRatio * 100}
            min={0.1}
            step={0.5}
            onCommit={(v) => set({ compressionRatio: v / 100 })}
          />
        </fieldset>
        <fieldset>
          <legend>om 参数</legend>
          <NumberField
            label="观察阈值"
            unit="tokens"
            defaultValue={params.observeThresholdTokens}
            min={1000}
            step={1000}
            onCommit={(v) => set({ observeThresholdTokens: v })}
          />
          <NumberField
            label="反思阈值"
            unit="tokens"
            defaultValue={params.reflectThresholdTokens}
            min={1000}
            step={1000}
            onCommit={(v) => set({ reflectThresholdTokens: v })}
          />
          <NumberField
            label="表格步长"
            unit="tokens"
            defaultValue={params.tableStepTokens}
            min={1000}
            step={1000}
            onCommit={(v) => set({ tableStepTokens: v })}
          />
        </fieldset>
        <fieldset>
          <legend>Token 价格（USD / 1M，默认 Opus）</legend>
          <NumberField
            label="输入"
            unit="$/1M"
            defaultValue={OPUS_PRICES.input}
            min={0}
            step={0.1}
            onCommit={(v) => setPrice('input', v)}
          />
          <NumberField
            label="补全"
            unit="$/1M"
            defaultValue={OPUS_PRICES.completion}
            min={0}
            step={0.1}
            onCommit={(v) => setPrice('completion', v)}
          />
          <NumberField
            label="缓存读取"
            unit="$/1M"
            defaultValue={OPUS_PRICES.cacheRead}
            min={0}
            step={0.1}
            onCommit={(v) => setPrice('cacheRead', v)}
          />
          <NumberField
            label="缓存创建"
            unit="$/1M"
            defaultValue={OPUS_PRICES.cacheWrite}
            min={0}
            step={0.1}
            onCommit={(v) => setPrice('cacheWrite', v)}
          />
        </fieldset>
      </div>
    </section>
  );
}
