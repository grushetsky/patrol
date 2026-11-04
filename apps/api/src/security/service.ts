import type { Connectable } from "../db/migrations.js";
import { pageOf, type Page } from "../http.js";
import { iso } from "../catalogue/records.js";

export interface SecurityEventFilters {
  kind?: string;
  operatorId?: string;
}

/** The append-only authentication audit read surface. */
export class SecurityEventService {
  constructor(private readonly db: Connectable) {}

  async list(filters: SecurityEventFilters, page: Page) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.kind) {
      values.push(filters.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (filters.operatorId) {
      values.push(filters.operatorId);
      conditions.push(`operator_id = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = (
      await this.db.query(
        `SELECT * FROM security_event ${where} ORDER BY created_at DESC`,
        values,
      )
    ).rows;
    return pageOf(rows.map(toSecurityEvent), page);
  }
}

function toSecurityEvent(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    ...(row.operator_id ? { operatorId: String(row.operator_id) } : {}),
    ...(row.email ? { email: String(row.email) } : {}),
    ...(row.coarse_ip ? { coarseIp: String(row.coarse_ip) } : {}),
    ...(row.user_agent ? { userAgent: String(row.user_agent) } : {}),
    ...(row.detail ? { detail: String(row.detail) } : {}),
    createdAt: iso(row.created_at),
  };
}
