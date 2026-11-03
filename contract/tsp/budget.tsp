namespace Patrol.Domain;

// The acquisition ledger and the re-check ladder. The ledger, not the provider,
// is the budget authority; a reservation is held before a scan spends and
// converted to committed units for the queries it actually issued.

@doc("One engine's allowance for one UTC calendar month.")
model QuotaLedger {
  @doc("Patrol's own identifier.")
  id: QuotaLedgerId;

  @doc("The engine the row belongs to.")
  engine: Engine;

  @doc("The first day of the UTC month the row covers.")
  monthStart: plainDate;

  @doc("The month's billable units for the engine.")
  @minValue(0)
  allowanceUnits: int32;

  @doc("Units reserved by scans and not yet settled.")
  @minValue(0)
  scanReserved: int32;

  @doc("Units committed by scans.")
  @minValue(0)
  scanCommitted: int32;

  @doc("Units reserved by re-checks and not yet settled.")
  @minValue(0)
  recheckReserved: int32;

  @doc("Units committed by re-checks.")
  @minValue(0)
  recheckCommitted: int32;
}

@doc("A scan's hold on a slice of an engine allowance. Held before the scan runs, then committed or released.")
model BudgetReservation {
  @doc("Patrol's own identifier.")
  id: BudgetReservationId;

  @doc("The scan holding the reservation.")
  scanId: ScanId;

  @doc("The engine whose allowance is reserved.")
  engine: Engine;

  @doc("The bucket the reservation draws on.")
  bucket: BudgetBucket;

  @doc("The number of billable units reserved.")
  @minValue(0)
  units: int32;

  @doc("The reservation's state.")
  state: ReservationState;

  @doc("When the reservation was made.")
  createdAt: utcDateTime;

  @doc("When an unstarted reservation expires; one hour after it was made.")
  expiresAt: utcDateTime;

  @doc("When the reservation was committed, released, or expired.")
  settledAt?: utcDateTime;

  @doc("The units the scan actually issued at settlement; a partial scan commits these and releases the rest.")
  @minValue(0)
  committedUnits?: int32;

  @doc("The units released at settlement, including every unit of a failed or expired reservation.")
  @minValue(0)
  releasedUnits?: int32;
}

@doc("The re-check ladder for one title group and engine.")
model RecheckSchedule {
  @doc("Patrol's own identifier.")
  id: RecheckScheduleId;

  @doc("The title group the ladder belongs to.")
  titleGroupId: TitleGroupId;

  @doc("The engine the ladder re-checks on.")
  engine: Engine;

  @doc("The ladder's rung: one for three days, two for seven, three for fourteen, then every fourteen days.")
  @minValue(1)
  rung: int32;

  @doc("When the next re-check falls due.")
  nextDueAt: utcDateTime;

  @doc("Whether the ladder is running. It stops when no violation from the pair is open.")
  active: boolean;

  @doc("The scan that started or last reset the ladder.")
  startedByScanId: ScanId;

  @doc("When the ladder was last updated.")
  updatedAt: utcDateTime;
}
