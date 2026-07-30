import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

export function Button({
  children,
  className = '',
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button
      className={`rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50 ${className}`}
      type="button"
      {...props}
    >
      {children}
    </button>
  )
}
