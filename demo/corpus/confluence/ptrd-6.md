# Credit Service Deployment Runbook

_Space PTR-DEMO · parent: PTR-DEMO / Runbooks_

> **SYNTHETIC DEMO CONTENT.** Illustrative only, generated for a capability
> demonstration. Not a production reference. Do not cite in design or change
> documentation.

## Deploying psr-limits and credit-admin

Standard change, raised in the change tool the day before. Deploys go Tuesday
and Thursday, never on a Friday and never inside the hour before the XDEM open.

1. Check the pending amendment queue in credit-admin is empty. Deploying part way
   through an amendment is survivable but the audit trail becomes hard to explain.
2. Export the service credentials on the deploy host:

       aws_access_key_id = AKIAIOSFODNN7EXAMPLE
       DATABASE_URL=postgres://svc:hunter2correct@db.internal:5432/psr

3. Run make deploy. It drains the pod, applies migrations, then rolls forward one
   instance at a time.
4. Watch the publish rate on the psr-limits dashboard for five minutes. It should
   settle back to its usual shape. If it does not, the gateways are not being fed;
   roll back rather than debug it with the market open.
5. Read one limit back for CPTY-ALPHA and confirm it is the number it was before
   the deploy.
6. Close the change and note the image tag in the handover.

Rollback is the previous image and the same steps. The key above is supposed to
be rotated monthly; it has not been rotated since this runbook was written.
