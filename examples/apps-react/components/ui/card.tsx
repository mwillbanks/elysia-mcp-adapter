import type { PropsWithChildren } from 'react'

export function Card({ children }: PropsWithChildren) {
  return (
    <main className="mx-auto max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
      {children}
    </main>
  )
}

export function CardHeader({ children }: PropsWithChildren) {
  return <header className="border-b border-border p-5">{children}</header>
}

export function CardContent({ children }: PropsWithChildren) {
  return <section className="grid gap-4 p-5">{children}</section>
}
