/**
 * 参数面板：会话 / om / 价格三组可调项（滑块 + 数字输入联动）。
 * 右侧侧边栏布局，可滚动。导出 ParamsPanel。
 */
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  /** 输入框草稿：编辑期间允许暂时清空或键入非法值，失焦后回落到受控值。 */
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          {tooltip !== undefined ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-[10px] text-muted-foreground/70">ⓘ</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-48">{tooltip}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-6 w-20 px-1.5 text-right text-xs tabular-nums"
            value={draft ?? String(value)}
            step={step}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              const n = Number(raw);
              // 只要求非负数；空串与非法值仅保留在草稿中，不写回
              if (raw.trim() !== '' && Number.isFinite(n) && n >= 0) onChange(n);
            }}
            onBlur={() => setDraft(null)}
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
          setDraft(null);
          if (v !== undefined) onChange(v);
        }}
      />
    </div>
  );
}

/** 布尔参数项属性。 */
type CheckFieldProps = {
  /** 字段标签。 */
  label: string;
  /** 字段说明（可选，悬停显示）。 */
  tooltip?: string;
  /** 当前值（受控）。 */
  checked: boolean;
  /** 值变更回调。 */
  onChange: (checked: boolean) => void;
};

/** 勾选框参数项：标签 + 勾选框，说明悬停显示。 */
function CheckField({ label, tooltip, checked, onChange }: CheckFieldProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        {tooltip !== undefined ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-[10px] text-muted-foreground/70">ⓘ</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-48">{tooltip}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <input
        type="checkbox"
        className="h-3.5 w-3.5 cursor-pointer accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
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
            label="step平均输出"
            tooltip="每个step模型输出的thinking、text、tool-args"
            unit="tok"
            value={params.stepOutputTokens}
            min={0}
            max={10000}
            step={100}
            onChange={(v) => set({ stepOutputTokens: v })}
          />
          <SliderField
            label="step平均输入"
            tooltip="每个step输入给模型的text、用户或系统消息、tool-result"
            unit="tok"
            value={params.stepInputTokens}
            min={0}
            max={30000}
            step={100}
            onChange={(v) => set({ stepInputTokens: v })}
          />
          <SliderField
            label="压缩比"
            tooltip="摘要输出 / 被压缩消息，只决定压缩后 history 块在上下文中的大小，不参与计费"
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
            label="OM token消耗比"
            tooltip="OM观察/摘要时，输出token相对输入消息的token的比值，按输出计费"
            unit="%"
            value={Math.round(params.omTokenRatio * 100)}
            min={0}
            max={200}
            step={5}
            onChange={(v) => set({ omTokenRatio: v / 100 })}
          />
          <CheckField
            label="压缩 thinking"
            tooltip="开启后观察压缩时 thinking 随被压缩消息一并输入 OM（计入摘要输入与 OM token消耗比基数）；关闭时 thinking 只按输出计费，不进 OM"
            checked={params.compressThinking}
            onChange={(v) => set({ compressThinking: v })}
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
