import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useI18n } from '@bestie/i18n';
import type { ErrorKey } from '@bestie/i18n';
import { Spinner } from './Spinner';
import { useAsyncAction } from './useAsyncAction';

type Variant = 'primary' | 'secondary' | 'danger';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onClick: (event: MouseEvent<HTMLButtonElement>) => Promise<unknown> | unknown;
  variant?: Variant;
  /** Called with an `err_*` code when the action throws. */
  onActionError?: (code: ErrorKey) => void;
  children: ReactNode;
};

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn',
  secondary: 'btn btn-secondary',
  danger: 'btn btn-danger',
};

/**
 * The default button for anything that does work. While the action runs it shows a spinner,
 * announces itself as busy to screen readers and ignores further clicks; when the action
 * settles the spinner disappears.
 */
export function AsyncButton({
  onClick,
  onActionError,
  variant = 'primary',
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: Props) {
  const { t } = useI18n();
  const { run, pending } = useAsyncAction(onClick, { onError: onActionError });

  return (
    <button
      {...rest}
      type={type}
      className={`${VARIANT_CLASS[variant]} ${className}`.trim()}
      aria-busy={pending || undefined}
      aria-disabled={disabled || pending || undefined}
      disabled={disabled}
      onClick={(e) => {
        if (pending) return;
        void run(e);
      }}
    >
      {pending ? <Spinner /> : null}
      <span>{children}</span>
      {pending ? (
        <span role="status" className="visually-hidden">
          {t.loading}
        </span>
      ) : null}
    </button>
  );
}
