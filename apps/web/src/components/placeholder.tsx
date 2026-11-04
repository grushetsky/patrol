import { Link } from "@tanstack/react-router";
import { translate, useLanguage, type MessageKey } from "../i18n";
import { Button, Card, EmptyState } from "./ui";

export function NextSlice({ section }: { section: MessageKey }) {
  const language = useLanguage();
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          {translate(language, "appTitle")}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {translate(language, section)}
        </h1>
      </header>
      <Card>
        <EmptyState
          title={translate(language, "nextSlice")}
          action={
            <Link to="/dashboard">
              <Button variant="secondary">{translate(language, "backToDashboard")}</Button>
            </Link>
          }
        >
          {translate(language, "nextSliceLead")}
        </EmptyState>
      </Card>
    </div>
  );
}
