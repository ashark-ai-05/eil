# Payment Retry Policy

This page describes how the gateway retries failed payment authorisations.

> Owned by the Payments platform team.

## Backoff schedule

| Attempt | Delay | Terminal? |
| --- | --- | --- |
| 1 | 30s | no |
| 2 | 2m | no |
| 3 | 10m | yes |

## Guard clause

The worker gives up after the third attempt:

```bash
if [ "$RETRY_COUNT" -gt 3 ]; then
    echo "giving up on $PAYMENT_ID"
    exit 1
fi
```

## See also

Escalation lives in [the escalation runbook](<confluence://page/OPS/Payment Escalation Runbook>), and the original design is [retry-design.pdf](<confluence://attachment/retry-design.pdf>).

External reference: [Stripe retry docs](https://stripe.example/docs/retries).

> Do not raise the cap without a capacity review.