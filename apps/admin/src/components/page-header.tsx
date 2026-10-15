import React, { useEffect, useRef } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The shell focuses the title on route change; a page that swaps its loading header for the
  // loaded one would drop that focus to <body>, so the new title picks it up again.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) heading.current?.focus();
  }, []);
  useEffect(() => {
    document.title = `${title} · Admin Flaremmerce`;
  }, [title]);
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 ref={heading} id="page-title" tabIndex={-1} className="text-2xl font-semibold tracking-tight break-words outline-none">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
