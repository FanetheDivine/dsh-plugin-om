/**
 * 参数面板：会话假设 / om 参数 / Token 价格三组可调项（滑块 + 数字输入联动），
 * 吸顶布局（sticky），滚动表格时配置项始终停留在视口顶部。导出 ParamsPanel。
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import type { ModelParams } from '../model';

/** 单个可调参数项属性。 */
type SliderFieldProps = {
  /** 字段标签。 */
  label: string;
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
function SliderField({ label, value, min, max, step, unit, onChange }: SliderFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-7 w-24 px-2 text-right text-xs tabular-nums"
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
            <span className="text-xs text-muted-foreground whitespace-nowrap">{unit}</span>
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

/** 参数面板组件：吸顶容器 + 三组滑块字段 + 恢复默认按钮。 */
export function ParamsPanel({ params, onChange, onReset }: ParamsPanelProps) {
  const set = (patch: Partial<ModelParams>) => onChange({ ...params, ...patch });
  const setPrice = (key: keyof ModelParams['prices'], value: number) =>
    onChange({ ...params, prices: { ...params.prices, [key]: value } });
  return (
    <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="text-sm font-semibold">可调参数</h3>
          <button
            type="button"
            className="text-xs rounded-md border px-2 py-1 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            onClick={onReset}
          >
            恢复默认
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 pb-4 md:grid-cols-2 xl:grid-cols-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground">会话假设</legend>
            <SliderField
              label="系统提示词"
              unit="tokens"
              value={params.systemPromptTokens}
              min={0}
              max={30000}
              step={500}
              onChange={(v) => set({ systemPromptTokens: v })}
            />
            <SliderField
              label="dsh 注入消息"
              unit="tokens"
              value={params.injectedTokens}
              min={0}
              max={30000}
              step={500}
              onChange={(v) => set({ injectedTokens: v })}
            />
            <SliderField
              label="每轮新增"
              unit="tokens"
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
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground">om 参数</legend>
            <SliderField
              label="观察阈值"
              unit="tokens"
              value={params.observeThresholdTokens}
              min={5000}
              max={150000}
              step={1000}
              onChange={(v) => set({ observeThresholdTokens: v })}
            />
            <SliderField
              label="反思阈值"
              unit="tokens"
              value={params.reflectThresholdTokens}
              min={10000}
              max={400000}
              step={5000}
              onChange={(v) => set({ reflectThresholdTokens: v })}
            />
            <SliderField
              label="表格步长"
              unit="tokens"
              value={params.tableStepTokens}
              min={5000}
              max={50000}
              step={1000}
              onChange={(v) => set({ tableStepTokens: v })}
            />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground">
              Token 价格（USD / 1M，默认 Opus）
            </legend>
            <SliderField
              label="输入"
              unit="$/1M"
              value={params.prices.input}
              min={0}
              max={20}
              step={0.1}
              onChange={(v) => setPrice('input', v)}
            />
            <SliderField
              label="补全"
              unit="$/1M"
              value={params.prices.completion}
              min={0}
              max={100}
              step={0.5}
              onChange={(v) => setPrice('completion', v)}
            />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-muted-foreground">缓存价格</legend>
            <SliderField
              label="缓存读取"
              unit="$/1M"
              value={params.prices.cacheRead}
              min={0}
              max={10}
              step={0.05}
              onChange={(v) => setPrice('cacheRead', v)}
            />
            <SliderField
              label="缓存创建"
              unit="$/1M"
              value={params.prices.cacheWrite}
              min={0}
              max={20}
              step={0.05}
              onChange={(v) => setPrice('cacheWrite', v)}
            />
          </fieldset>
        </div>
      </div>
    </div>
  );
}
