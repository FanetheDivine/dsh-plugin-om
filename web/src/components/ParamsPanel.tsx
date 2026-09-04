/**
 * 参数面板：会话 / om / 价格三组可调项（滑块 + 数字输入联动）。
 * 右侧侧边栏布局，可滚动。导出 ParamsPanel。
 */
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import type { ModelParams } from '../model';

/** 单个可调参数项属性。 */
type SliderFieldProps = {
  /** 字段标签。 */
  label: string;
  /** 字段说明（可选，悬停显示）。 */
  tooltip?: string;
  /** 当前值（受控）。 */
  value: number;
  /** 滑块最小值。 */
  min: number;
  /** 滑块最大值。 */
  max: number;
  /** 步进。 */
  step: number;
  /** 单位后缀（展示用）。 */
  unit?: string;
  /** 值变更回调。 */
  onChange: (value: number) => void;
};

/** 滑块 + 数字输入联动的参数项：滑块拖动与键盘输入都直接写回受控值。 */
function SliderField({ label, tooltip, value, min, max, step, unit, onChange }: SliderFieldProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          {tooltip !== undefined ? (
            <button
              type="button"
              className="text-[10px] text-muted-foreground/70"
              aria-label={tooltip}
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
            >
              ⓘ
            </button>
          ) : null}
          {open && tooltip !== undefined ? (
            <span className="absolute left-0 top-full z-10 mt-1 w-40 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
              {tooltip}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-6 w-20 px-1.5 text-right text-xs tabular-nums"
            value={value}
            min={min}
            step={step}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min) onChange(n);
            }}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!(Number.isFinite(n) && n >= min)) onChange(min);
            }}
          />
          {unit !== undefined ? (
            <span className="w-7 text-xs text-muted-foreground">{unit}</span>
          ) : null}
        </div>
      </div>
      <Slider
        value={[Math.min(Math.max(value, min), max)]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => {
          if (v !== undefined) onChange(v);
        }}
      />
    </div>
  );
}

/** 参数面板属性。 */
type ParamsPanelProps = {
  /** 当前参数。 */
  params: ModelParams;
  /** 参数变更回调。 */
  onChange: (next: ModelParams) => void;
  /** 恢复默认的回调。 */
  onReset: () => void;
};

/** 侧边栏参数面板：分组滑块 + 恢复默认按钮。 */
export function ParamsPanel({ params, onChange, onReset }: ParamsPanelProps) {
  const set = (patch: Partial<ModelParams>) => onChange({ ...params, ...patch });
  const setPrice = (key: keyof ModelParams['prices'], value: number) =>
    onChange({ ...params, prices: { ...params.prices, [key]: value } });
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold">参数</h2>
        <button
          type="button"
          className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          onClick={onReset}
        >
          恢复默认
        </button>
      </div>
      <div className="space-y-5 px-4 pb-4">
        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            会话
          </legend>
          <SliderField
            label="系统提示词"
            unit="tok"
            value={params.systemPromptTokens}
            min={0}
            max={30000}
            step={500}
            onChange={(v) => set({ systemPromptTokens: v })}
          />
          <SliderField
            label="dsh 注入"
            tooltip="AGENTS.md、skill 定义等系统消息，首次观察压缩后遮蔽为空条目"
            unit="tok"
            value={params.injectedTokens}
            min={0}
            max={30000}
            step={500}
            onChange={(v) => set({ injectedTokens: v })}
          />
          <SliderField
            label="每轮新增"
            tooltip="每轮用户消息 + 模型回复的 token 增量，双方各半"
            unit="tok"
            value={params.turnDeltaTokens}
            min={500}
            max={10000}
            step={100}
            onChange={(v) => set({ turnDeltaTokens: v })}
          />
          <SliderField
            label="压缩比"
            unit="%"
            value={Math.round(params.compressionRatio * 1000) / 10}
            min={0.5}
            max={20}
            step={0.5}
            onChange={(v) => set({ compressionRatio: v / 100 })}
          />
        </fieldset>

        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            om
          </legend>
          <SliderField
            label="观察阈值"
            unit="tok"
            value={params.observeThresholdTokens}
            min={5000}
            max={150000}
            step={1000}
            onChange={(v) => set({ observeThresholdTokens: v })}
          />
          <SliderField
            label="反思阈值"
            unit="tok"
            value={params.reflectThresholdTokens}
            min={10000}
            max={400000}
            step={5000}
            onChange={(v) => set({ reflectThresholdTokens: v })}
          />
          <SliderField
            label="表格步长"
            unit="tok"
            value={params.tableStepTokens}
            min={5000}
            max={50000}
            step={1000}
            onChange={(v) => set({ tableStepTokens: v })}
          />
        </fieldset>

        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            价格 / 1M
          </legend>
          <SliderField
            label="输入"
            unit="$"
            value={params.prices.input}
            min={0}
            max={20}
            step={0.1}
            onChange={(v) => setPrice('input', v)}
          />
          <SliderField
            label="输出"
            unit="$"
            value={params.prices.completion}
            min={0}
            max={100}
            step={0.5}
            onChange={(v) => setPrice('completion', v)}
          />
          <SliderField
            label="缓存读"
            unit="$"
            value={params.prices.cacheRead}
            min={0}
            max={10}
            step={0.05}
            onChange={(v) => setPrice('cacheRead', v)}
          />
          <SliderField
            label="缓存写"
            unit="$"
            value={params.prices.cacheWrite}
            min={0}
            max={20}
            step={0.05}
            onChange={(v) => setPrice('cacheWrite', v)}
          />
        </fieldset>
      </div>
    </div>
  );
}
