---
'@cadenway/nest-messaging': patch
---

Keep legacy outbox publication outside ambient transactions and on one database attempt. The
relay still retries failed settlements and JetStream still redelivers failed consumer transactions.
