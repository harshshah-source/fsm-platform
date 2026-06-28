import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { buildNav } from './nav';

/** Dark, role-grouped icon sidebar (reference chrome). Active item = brand left-accent + tint. */
export function Sidebar({ role }: { role: string }) {
  const { pathname } = useLocation();
  const groups = buildNav(role);
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

  return (
    <nav
      aria-label="Primary"
      className="flex w-56 shrink-0 flex-col bg-chrome-900 text-chrome-text"
    >
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          A
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">autoplant systems</div>
          <div className="text-[10px] uppercase tracking-wider text-chrome-muted">
            Field Management System
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {groups.map((g) => (
          <div key={g.heading} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-chrome-muted">
              {g.heading}
            </div>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.to);
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-r-md border-l-2 px-2 py-1.5 text-[13px] transition-colors',
                        active
                          ? 'border-brand-600 bg-chrome-700 text-white'
                          : 'border-transparent text-chrome-text hover:bg-chrome-800 hover:text-white',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 text-[10px] text-chrome-muted">Admin Console v2.0 · role-gated nav</div>
    </nav>
  );
}
