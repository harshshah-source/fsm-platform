-- #266 item 5 — retire the three scoring weights the recommender has never read.
--
-- `company_tier`, `device_bucket` and `sla_urgency` were seeded as `priority_rule_config` components
-- in Issue 02. They are not score components and never were: the company tier and the device SLA
-- bucket are the UPSTREAM gates that decide the canonical ticket ORDER, before any engineer is
-- considered. `scoreCandidate` reads only company_priority_rank, dispatch_urgency,
-- repeat_failure_penalty, distance, repeat_failure_bonus and device_age — a grep of src/recommender
-- returns zero hits for the three retired here.
--
-- They were not merely inert. `activeWeights` loads every ACTIVE row of the resolved weight set into
-- the weights map, and that map is persisted verbatim as `recommendations.score_breakdown.weights`,
-- so every stored explanation carried three numbers that contributed nothing to the score it was
-- explaining — and the admin settings table listed them beside the real levers with no way to tell
-- the difference. #266 exists to stop the scoring surface implying influence it does not have; these
-- are the same defect one layer out.
--
-- DEACTIVATED, not deleted. `priority_rule_config` is operator-tunable and audited
-- (SCORING_WEIGHT_UPDATED), so the rows are history: a past run's stamped `weight_set_ref` should
-- still resolve to the row set that was live when it ran. `active = false` removes them from
-- `activeWeights` (which filters on it) and therefore from every future breakdown, while leaving the
-- record that they once existed. Reversible by flipping the flag back.
--
-- Scoped to these three components across every weight set, including the `_preventive` variants,
-- because the defect is the component name rather than any one set. Idempotent.
UPDATE "priority_rule_config"
   SET "active" = false
 WHERE "component" IN ('company_tier', 'device_bucket', 'sla_urgency')
   AND "active" = true;
