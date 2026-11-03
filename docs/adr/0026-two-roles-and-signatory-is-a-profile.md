# Two roles exist, and the signatory is a profile rather than an account

The role set is `Administrator` and `Operator`. An operator reviews, composes and approves notices, records submissions, edits the catalogue and its scan settings, and runs manual scans; an administrator additionally manages operators and invitations, the rights holder and signatory, recipient profiles, the acquisition budget, legal holds, and a profile paused by the rejection threshold. The signatory holds no credentials: it is a name and an authority basis in the rights holder's settings, snapshotted into each notice at approval.

## Considered options

- **One role for everyone.** Simplest, and it lets any operator change the recipient profiles, the budget, or another operator's access, which is the blast radius an incident response needs to contain.
- **A role per step — reviewer, approver, submitter.** Matches the workflow, and every notice would need at least two distinct people, which is impossible in a one-person deployment and an operational tax in a small one.
- **The signatory as an account that signs in.** Makes the signature an explicit act by the signer, but it makes one person the throughput ceiling for every notice and duplicates the operator set when the signer is also an operator.
- **The rights holder as an account.** Treats a legal person as a login, which the glossary explicitly rejects.

## Consequences

- Every authenticated operator can approve a notice, and the approving operator is recorded, so control rests on audit and on the first-five second-operator check rather than on a permission bit.
- An administrator who is also the signatory configures the signatory profile once; a signatory change affects only new notices and does not require provisioning a person.
- There is no rights-holder login and no self-service: the rights holder's legal identity is data, not an actor.
- The small set means the only privilege boundary is operator administration plus configuration, which keeps the permission model explainable and the tests few.
- If the rights holder later needs an operator who may not approve notices, that is a new decision, not a hidden capability of this role set.
