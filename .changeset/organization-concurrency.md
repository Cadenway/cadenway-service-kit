---
'@cadenway/nest-jobs': minor
---

Add an optional organization concurrency limit to job queues. The producer derives the group from the caller's tenant transaction and workers apply that limit across replicas. Jobs without organization scope remain ungrouped.
