// The shared components every dashboard page is built from. Rules and tokens: docs/design/DESIGN.md.
import { useId, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { navigate } from "../App";

type Variant = "secondary" | "primary" | "quiet";

function btnClass(variant: Variant, big: boolean | undefined, extra: string | undefined): string {
  return ["btn", variant === "secondary" ? "" : variant, big ? "big" : "", extra ?? ""].filter(Boolean).join(" ");
}

/** A button. One `primary` per view; `quiet` for tertiary actions. Defaults to type="button". */
export function Button({
  variant = "secondary",
  big,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  return <button type={type} className={btnClass(variant, big, className)} {...rest} />;
}

/** An in-app link. Plain clicks navigate without a reload; modified clicks (new tab) keep the browser's behaviour. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

/** A link that looks like a button. */
export function LinkButton({ variant = "secondary", big, className, ...rest }: Parameters<typeof Link>[0] & { variant?: Variant; big?: boolean }) {
  return <Link className={btnClass(variant, big, className)} {...rest} />;
}

/**
 * A labelled form control: label above, the control, then an error (if any) or a help line under it.
 * The child is cloned with the id and aria-describedby/aria-invalid wiring, so pass a bare <input>, <select> or <textarea>.
 */
export function Field({
  label,
  help,
  error,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactElement;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": error || help ? noteId : undefined, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={noteId} className="ui-error" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={noteId} className="ui-help">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/** A small pill. `who` = who gets a fact; `warn` = needs attention. */
export function Badge({ tone, children, title }: { tone?: "who" | "warn"; children: ReactNode; title?: string }) {
  return (
    <span className={tone ? `ui-badge ${tone}` : "ui-badge"} title={title}>
      {children}
    </span>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLDivElement>, "className">) {
  return (
    <div className={className ? `ui-card ${className}` : "ui-card"} {...rest}>
      {children}
    </div>
  );
}

export interface Tab {
  to: string;
  label: ReactNode;
  /** Extra paths that also count as this tab (e.g. `/facts/<id>` for `/facts`). */
  match?: (path: string) => boolean;
  count?: number;
}

export function isCurrent(tab: Pick<Tab, "to" | "match">, path: string): boolean {
  return tab.match ? tab.match(path) : path === tab.to;
}

/** Underline tabs that are links. `label` names the nav landmark. */
export function Tabs({ tabs, path, label, className = "ui-tabs" }: { tabs: Tab[]; path: string; label: string; className?: string }) {
  return (
    <nav className={className} aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} aria-current={isCurrent(t, path) ? "page" : undefined}>
          {t.label}
          {t.count !== undefined && <span className="n">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A page's title, one line saying what the page is for, and at most one action. */
export function PageHeader({ title, lede, action }: { title: ReactNode; lede?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-page-head">
      <div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {action && <div className="end">{action}</div>}
    </div>
  );
}

/** What would appear here, and how it gets here. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
