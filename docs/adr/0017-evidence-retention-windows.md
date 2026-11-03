# Evidence is purged five years after closure, with a legal hold that outranks the clock

Evidence is the rights holder's only defence if a notice is challenged, so its retention is set above the period in which someone can still sue over that notice, never at it. United States copyright claims run three years from accrual under 17 U.S.C. §507(b), and a misrepresentation claim under §512(f) can accrue later than the notice, when the target learned of it; Russian claims run three years under ГК РФ art. 196. Patrol therefore keeps evidence while any violation or notice cites it, then for **five years** after the later of the violation's closure and the last submission citing it — the limitation period plus a two-year buffer for delayed accrual and service. Captures never cited by a violation survive twelve months past their last review decision. Raw search payloads Patrol owns are kept 90 days for parser audits, as provenance rather than evidence. A legal hold, recorded with its reason and operator, suspends every purge it covers until released.

## Considered options

- **Three years**: matches the limitation period exactly, which means the bytes disappear on the last day a claim can be filed — a purge timed to lose the defence.
- **One year**: cheapest, but the rights holder could be sued over a notice after its own evidence is gone.
- **Indefinite retention**: no decision to get wrong, but Patrol would become a permanent archive of third-party pages, including advertising and personal data, with no basis for holding them.
- **Hard deletion of the record**: loses the ability to explain what an already-approved notice cited.

## Consequences

- Purging removes bytes and leaves the record: the evidence row, its artifact hashes and sizes, and a purge marker survive, so an old notice still explains what it cited.
- A legal hold overrides every automatic deletion path — the retention deadline, bucket lifecycle expiry, deletion at violation closure, and shared-blob cleanup — because spoliation sanctions under FRCP 37(e) are the cost of a deletion that ran while a dispute was reasonably anticipated.
- Storage retention is a floor, not a schedule: an object locked in compliance mode cannot be deleted before its date, so the retention window is written onto the object at capture and extended when a later citation pushes the deadline out; a purge run can only remove what has lapsed.
- A blob is deleted only when no unpurged artifact references its hash, and metadata markers are written before bytes, so an interrupted purge leaves orphaned bytes rather than dangling citations.
- Development and small providers without Object Lock enforce immutability through grants and policy, which is weaker than storage-enforced WORM and is accepted for non-production.
