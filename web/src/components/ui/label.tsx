/**
 * shadcn/ui Label 组件。
 * 导出 Label。
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/** 标签组件（原语；关联在用法侧通过 htmlFor 或包裹输入控件建立）。 */
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label };
