export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface QueryClient extends Queryable {
  release(): void;
}

export interface Connectable extends Queryable {
  connect(): Promise<QueryClient>;
}
