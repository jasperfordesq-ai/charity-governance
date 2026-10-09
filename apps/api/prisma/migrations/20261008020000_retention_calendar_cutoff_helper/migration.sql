BEGIN;

-- Arithmetic primitive only. No policy mode or disposal permission is added here.
-- Retention timestamps in this schema are stored as UTC timestamp(3).
CREATE FUNCTION "Retention_calendar_year_cutoff_utc"(anchor_at TIMESTAMP(3), years INTEGER)
RETURNS TIMESTAMP(3) AS $$
DECLARE
  target_year INTEGER;
  target_month INTEGER;
  target_day INTEGER;
  last_day INTEGER;
BEGIN
  IF anchor_at IS NULL OR years IS NULL OR years NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Calendar retention requires a UTC anchor and 1 to 100 whole years';
  END IF;
  target_year := EXTRACT(YEAR FROM anchor_at)::INTEGER + years;
  IF EXTRACT(YEAR FROM anchor_at) NOT BETWEEN 1 AND 9999 OR target_year > 9999 THEN
    RAISE EXCEPTION 'Calendar retention cutoff is outside the supported date range';
  END IF;
  target_month := EXTRACT(MONTH FROM anchor_at)::INTEGER;
  last_day := EXTRACT(DAY FROM
    make_date(target_year, target_month, 1) + INTERVAL '1 month - 1 day')::INTEGER;
  target_day := LEAST(EXTRACT(DAY FROM anchor_at)::INTEGER, last_day);
  RETURN make_date(target_year, target_month, target_day) + anchor_at::TIME;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
