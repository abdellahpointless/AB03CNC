import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';

export interface GlassOption {
  value: string;
  label: string;
}

/**
 * The app's dropdown: a Radix menu of radio items (keyboard, typeahead, screen readers), styled with the glass tokens.
 * Non-modal on purpose: a modal Select hides the whole page from assistive tech while it is open.
 */
export function GlassSelect({ value, onValueChange, options, label, placeholder, disabled, title, className = '' }: {
  value: string;
  onValueChange: (v: string) => void;
  options: GlassOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const current = options.find((o) => o.value === value)?.label ?? placeholder ?? '';
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger disabled={disabled} aria-label={`${label}: ${current}`} title={title} className={`glass-select-trigger ${className}`}>
        <span>{current}</span>
        <ChevronDown size={15} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="glass-select-content" aria-label={label}>
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange} className="p-1">
            {options.map((o) => (
              <DropdownMenu.RadioItem key={o.value} value={o.value} className="glass-select-item">
                <span>{o.label}</span>
                <DropdownMenu.ItemIndicator className="ml-auto text-[var(--accent-primary)]">
                  <Check size={14} aria-hidden />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
